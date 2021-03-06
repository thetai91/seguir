var moment = require('moment');
var async = require('async');
var _ = require('lodash');
var debug = require('debug')('seguir:feed');

var MENTION = new RegExp('@[a-zA-Z0-9]+', 'g');
var FEEDS = ['feed_timeline', 'user_timeline'];
var DEFAULT_PAGESIZE = 50;

/**
 * This is a collection of methods that allow you to create, update and delete social items.
 *
 * These methods all exclude the 'loggedinuser' parameter as they are all carried out only by
 * the currently logged in user and / or system level calls (e.g. adding a user via integration
 * with an SSO flow).
 *
 * TODO: Exception may be creating a post on someone elses feed.
 *
 */
module.exports = function (api) {
  var client = api.client;
  var messaging = api.messaging;
  var q = client.queries;

  function insertFollowersTimeline (jobData, next) {
    var read = 0;
    var finished = 0;
    var done = false;

    function nextIfFinished (doNotIncrement) {
      if (!doNotIncrement) { finished++; }
      if (read === finished && done) { next(); }
    }

    // If you are the recipient of a follow, do not copy this out to your follow graph - it will appear in your feed only
    if (jobData.type === 'follow' && (jobData.user.toString() === jobData.object.user.toString())) { return next(); }

    // If you the action is personal do not copy out to followers feeds
    if (jobData.visibility === api.visibility.PERSONAL) { return next(); }

    client.stream(q(jobData.keyspace, 'selectFollowers'), [jobData.user], function (err, stream) {
      if (err) { return next(err); }
      stream
        .on('data', function (row) {
          read++;
          var isPrivate = jobData.visibility === api.visibility.PRIVATE;
          var followerIsFollower = jobData.type === 'follow' && (row.user_follower.toString() === jobData.object.user_follower.toString());
          // Follow is added to followers feed directly, not via the follow relationship
          if (followerIsFollower) {
            return nextIfFinished();
          }
          api.friend.isFriend(jobData.keyspace, row.user, row.user_follower, function (err, isFriend) {
            if (err) {
              console.log('error while fetching is friend (' + row.user + ':' + row.user_follower + ')');
              return nextIfFinished();
            }
            if (!isPrivate || (isPrivate && isFriend)) {
              upsertTimeline(jobData.keyspace, 'feed_timeline', row.user_follower, jobData.id, jobData.type, jobData.timestamp, jobData.visibility, row.follow, nextIfFinished);
            } else {
              nextIfFinished();
            }
          });
        })
        .on('end', function () {
          done = true;
          nextIfFinished(true);
        })
        .on('error', function (err) {
          next(err);
        });
    });
  }

  function insertMentionedTimeline (jobData, next) {
    var getPost = function (cb) {
      api.post.getPost(jobData.keyspace, jobData.user, jobData.id, function (err, post) {
        if (err || !post || post.content_type !== 'text/html') return cb();
        cb(null, post.content);
      });
    };

    var getMentionedUsers = function (content, cb) {
      if (!cb) { return content(); } // no mentioned users
      var users = content.match(MENTION);
      if (users && users.length > 0) {
        users = users.map(function (user) {
          return user.replace('@', '');
        });
        async.map(users, function (username, cb2) {
          api.user.getUserByName(jobData.keyspace, username, function (err, mentionedUser) {
            if (err || !mentionedUser) {
              return cb2();
            }
            api.friend.isFriend(jobData.keyspace, mentionedUser.user, jobData.user, function (err, isFriend) {
              if (err) return cb2(err);
              mentionedUser.isFriend = isFriend;
              cb2(null, mentionedUser);
            });
          });
        }, cb);
      } else {
        return cb();
      }
    };

    var getMentionedNotFollowers = function (mentioned, cb) {
      if (!cb) { return mentioned(); } // no mentioned users
      client.execute(q(jobData.keyspace, 'selectFollowers'), [jobData.user], {}, function (err, data) {
        if (err) { return cb(err); }
        var followers = _.map(_.map(data || [], 'user_follower'), function (item) {
          return item.toString();
        });
        var mentionedNotFollowers = _.filter(mentioned, function (mentionedUser) {
          return !(_.includes(followers, mentionedUser.user.toString()) || mentionedUser.user.toString() === jobData.user.toString());
        });
        cb(null, mentionedNotFollowers);
      });
    };

    var insertMentioned = function (users, cb) {
      if (!cb) { return users(); } // no mentioned users
      async.map(users, function (mentionedUser, cb2) {
        var isPrivate = jobData.visibility === api.visibility.PRIVATE;
        if (!isPrivate || (isPrivate && mentionedUser.isFriend)) {
          upsertTimeline(jobData.keyspace, 'feed_timeline', mentionedUser.user, jobData.id, jobData.type, client.generateTimeId(jobData.timestamp), jobData.visibility, cb2);
        } else {
          cb2();
        }
      }, cb);
    };

    async.waterfall([
      getPost,
      getMentionedUsers,
      getMentionedNotFollowers,
      insertMentioned
    ], next);
  }

  function addFeedItem (keyspace, user, object, type, next) {
    var jobData = {
      keyspace: keyspace,
      user: user,
      object: object,
      id: object[type],
      type: type,
      timestamp: client.generateTimeId(object.timestamp),
      visibility: object.visibility
    };

    debug('Adding feed item', user, object, type);

    var _insertFollowersTimeline = function (cb) {
      if (messaging.enabled) {
        messaging.submit('seguir-publish-to-followers', jobData, cb);
      } else {
        insertFollowersTimeline(jobData, cb);
      }
    };

    var _insertMentionedTimeline = function (cb) {
      if (type !== 'post' || jobData.ispersonal) { return cb(); }
      if (messaging.enabled) {
        messaging.submit('seguir-publish-mentioned', jobData, cb);
      } else {
        insertMentionedTimeline(jobData, cb);
      }
    };

    var insertUserTimelines = function (cb) {
      async.map(FEEDS, function (timeline, cb2) {
        upsertTimeline(keyspace, timeline, jobData.user, jobData.id, jobData.type, jobData.timestamp, jobData.visibility, cb2);
      }, cb);
    };

    async.series([
      insertUserTimelines,
      _insertFollowersTimeline,
      _insertMentionedTimeline
    ], next);
  }

  function notify (keyspace, action, user, item) {
    var NOTIFY_Q = 'seguir-notify';
    if (!messaging.enabled || !messaging.feed) { return; }
    if (action === 'feed-add') {
      var expander = feedExpanders[item.type];
      if (expander) {
        api.user.getUser(keyspace, user, function (err, userObject) {
          if (err) { return; }
          expander(keyspace, user, item, function (err, expandedItem) {
            if (err) { return; }
            if (!expandedItem) {
              console.log('Unable to expand for notification user: ' + user + ', item: ' + JSON.stringify(item));
              return;
            }
            // Do not notify a user about things that they post or where they are the follower
            var isUser = expandedItem.type === 'follow'
            ? userObject.user.toString() === expandedItem.user_follower.user.toString()
            : userObject.user.toString() === expandedItem.user.user.toString();
            if (!isUser) {
              messaging.submit(NOTIFY_Q, {
                action: action,
                item: item,
                user: userObject,
                data: expandedItem
              });
            }
          });
        });
      }
    }
    if (action === 'feed-remove') {
      api.user.getUser(keyspace, user, function (err, userObject) {
        if (err) { return; }
        messaging.submit(NOTIFY_Q, {action: action, user: userObject, item: item});
      });
    }
    if (action === 'feed-view') {
      api.user.getUser(keyspace, user, function (err, userObject) {
        if (err) { return; }
        messaging.submit(NOTIFY_Q, {action: action, user: userObject});
      });
    }
  }

  function upsertTimeline (keyspace, timeline, user, item, type, time, visibility, from_follow, next) {
    if (!next) {
      next = from_follow;
      from_follow = null;
    }
    visibility = visibility || api.visibility.PUBLIC;
    var data = [user, item, type, time, visibility, from_follow];
    if (timeline === 'feed_timeline') notify(keyspace, 'feed-add', user, {item: item, type: type});
    debug('Upsert into timeline: ', timeline, user, item, type, time, visibility);
    client.execute(q(keyspace, 'upsertUserTimeline', {TIMELINE: timeline}), data, {}, next);
    api.metrics.increment('feed.' + timeline + '.' + type);
  }

  function removeFeedsForItem (keyspace, item, next) {
    async.map(FEEDS, function (timeline, cb) {
      _removeFeedsForItemFromTimeline(keyspace, timeline, item, cb);
    }, next);
  }

  function _removeFeedsForItemFromTimeline (keyspace, timeline, item, next) {
    var queryData = [item];
    client.execute(q(keyspace, 'selectAllItems', {TIMELINE: timeline}), queryData, {}, function (err, data) {
      /* istanbul ignore if */
      if (err || data.length === 0) { return next(err); }
      async.map(data, function (row, cb) {
        _removeFeedItemFromTimeline(keyspace, timeline, row.user, row.time, item, cb);
      }, function (err, rows) {
        next(err);
      });
    });
  }

  function removeFeedsOlderThan (keyspace, user, time, next) {
    async.map(FEEDS, function (timeline, cb) {
      _removeFeedsOlderThanFromTimeline(keyspace, timeline, user, time, cb);
    }, next);
  }

  function _removeFeedsOlderThanFromTimeline (keyspace, timeline, user, time, next) {
    var options = {raw: true, olderThan: client.generateTimeId(time), pageSize: 1000};
    _getFeed(keyspace, user, timeline, user, options, function (err, feed) {
      if (err) return next(err);
      async.map(feed, function (row, cb) {
        _removeFeedItemFromTimeline(keyspace, timeline, user, row.time, row.item, cb);
      }, next);
    });
  }

  function _removeFeedItemFromTimeline (keyspace, timeline, user, time, item, next) {
    var deleteData = [user, time];
    if (timeline === 'feed_timeline') notify(keyspace, 'feed-remove', user, {item: item, type: item.type});
    client.execute(q(keyspace, 'removeFromTimeline', {TIMELINE: timeline}), deleteData, {}, function (err, result) {
      if (err) return next(err);
      next(null, {status: 'removed'});
    });
  }

  function getUserFeed (keyspace, liu, user, options, next) {
    if (!next) {
      next = options;
      options = {};
    }
    _getFeed(keyspace, liu, 'user_timeline', user, options, next);
  }

  function getFeed (keyspace, liu, user, options, next) {
    if (!next) {
      next = options;
      options = {};
    }
    if (liu && liu.toString() === user.toString()) notify(keyspace, 'feed-view', user, {});
    _getFeed(keyspace, liu, 'feed_timeline', user, options, next);
  }

  function getRawFeed (keyspace, liu, user, options, next) {
    if (!next) {
      next = options;
      options = {};
    }
    _.merge(options, {raw: 'raw'});
    _getFeed(keyspace, liu, 'feed_timeline', user, options, next);
  }

  function getReversedUserFeed (keyspace, liu, user, options, next) {
    if (!next) {
      next = options;
      options = {};
    }
    _.merge(options, {raw: 'raw-reverse'});
    _getFeed(keyspace, liu, 'user_timeline', user, options, next);
  }

  /**
   * A collection of helpers based on type that will expand an item in the feed
   */
  var silentlyDropError = function (err, item, next) {
    if (err && (err.statusCode === 403 || err.statusCode === 404)) {
      next(); // Silently drop posts from the feed
    } else {
      if (err) { return next(err); }
      next(null, item);
    }
  };

  function expandPost (keyspace, liu, item, expandUser, cb) {
    if (!cb) {
      cb = expandUser;
      expandUser = true;
    }
    var hasEmbeddedPost = !!item.post_post;
    if (hasEmbeddedPost) {
      api.post.getPostFromObject(keyspace, liu, item, function (err, post) {
        silentlyDropError(err, post, cb);
      });
    } else {
      api.post.getPost(keyspace, liu, item.item, expandUser, function (err, post) {
        silentlyDropError(err, post, cb);
      });
    }
  }

  function expandLike (keyspace, liu, item, expandUser, cb) {
    if (!cb) {
      cb = expandUser;
      expandUser = true;
    }
    var hasEmbeddedLike = !!item.like_like;
    if (hasEmbeddedLike) {
      api.like.getLikeFromObject(keyspace, item, cb);
    } else {
      api.like.getLike(keyspace, item.item, expandUser, cb);
    }
  }

  function expandFollow (keyspace, liu, item, expandUser, cb) {
    if (!cb) {
      cb = expandUser;
      expandUser = true;
    }
    var hasEmbeddedFollow = !!item.follow_follow;
    if (hasEmbeddedFollow) {
      api.follow.getFollowFromObject(keyspace, liu, item, function (err, follow) {
        silentlyDropError(err, follow, cb);
      });
    } else {
      api.follow.getFollow(keyspace, liu, item.item, expandUser, function (err, follow) {
        silentlyDropError(err, follow, cb);
      });
    }
  }

  function expandFriend (keyspace, liu, item, expandUser, cb) {
    if (!cb) {
      cb = expandUser;
      expandUser = true;
    }
    var hasEmbeddedFriend = !!item.friend_friend;
    if (hasEmbeddedFriend) {
      api.friend.getFriendFromObject(keyspace, liu, item, function (err, friend) {
        silentlyDropError(err, friend, cb);
      });
    } else {
      api.friend.getFriend(keyspace, liu, item.item, expandUser, function (err, friend) {
        silentlyDropError(err, friend, cb);
      });
    }
  }

  function ensureFollowStillActive (keyspace, liu, item, cb) {
    if (!item.from_follow) { return cb(); }
    api.follow.getFollow(keyspace, liu, item.from_follow, function (err, follow) {
      if (err) { return cb(err); }
      cb();
    });
  }

  var feedExpanders = {
    'post': expandPost,
    'like': expandLike,
    'follow': expandFollow,
    'friend': expandFriend
  };

  function _getFeed (keyspace, liu, timeline, user, options, next) {
    var raw = options.raw;
    var feedType = options.type;
    var feedOlder = options.olderThan;
    var pageState = options.pageState;
    var pageSize = options.pageSize || DEFAULT_PAGESIZE;
    var typeQuery = '';
    var olderThanQuery = '';
    var data = [user];
    var query;

    if (feedType) {
      typeQuery = q(keyspace, 'typeQuery');
      data.push(feedType);
    }

    if (feedOlder && !feedType) {
      // Only allow one optional filter due to issue with postgres param numbering
      olderThanQuery = q(keyspace, 'olderThanQuery');
      data.push(feedOlder);
    }

    query = q(keyspace, 'selectTimeline', {TIMELINE: timeline, TYPEQUERY: typeQuery, OLDERTHANQUERY: olderThanQuery});

    api.metrics.increment('feed.' + timeline + '.list');

    client.execute(query, data, {pageState: pageState, pageSize: pageSize}, function (err, data, nextPageState) {
      if (err) { return next(err); }

      if (data && data.length > 0) {
        if (raw) { return next(null, data); }

        var timeline = data;
        var followCache = {};
        var expandUser = false;

        var expand = function (item, cb) {
          var expander = feedExpanders[item.type];
          if (expander) {
            return expander(keyspace, liu, item, expandUser, cb);
          } else {
            console.log('Unable to expand unknown feed item type: ' + item.type);
            cb();
          }
        };

        async.mapSeries(timeline, function (item, cb) {
          if (!item.from_follow) {
            return expand(item, cb);
          }

          var cachedFollowStatus = followCache[item.from_follow.toString()];
          if (cachedFollowStatus) {
            debug('follow cache HIT', item.from_follow.toString());
            if (cachedFollowStatus === 'active') {
              return expand(item, cb);
            } else {
              return cb();
            }
          }

          debug('follow cache MISS', item.from_follow.toString());
          ensureFollowStillActive(keyspace, liu, item, function (err) {
            if (err) {
              followCache[item.from_follow.toString()] = 'not-active';
              return cb();
            }
            followCache[item.from_follow.toString()] = 'active';
            expand(item, cb);
          });
        }, function (err, results) {
          /* Ensure caches clear */
          followCache = null;

          /* istanbul ignore if */
          if (err || !results) { return next(err); }

          var feed = [];
          var userCache = {};

          // Now go and get the users in one go so we can cache results
          api.user.mapUserIdToUser(keyspace, results, ['user', 'user_follower', 'user_friend'], liu, true, userCache, function (err, resultsWithUsers) {
            if (err) { return next(err); }

            resultsWithUsers.forEach(function (result, index) {
              if (result) {
                var currentResult = result;

                // Copy elements from feed
                currentResult._item = timeline[index].item;
                currentResult.type = timeline[index].type;
                currentResult.timeuuid = timeline[index].time;
                currentResult.date = timeline[index].date;
                currentResult.fromNow = moment(currentResult.date).fromNow();
                currentResult.visibility = timeline[index].visibility || api.visibility.PUBLIC;
                currentResult.isPrivate = currentResult.visibility === api.visibility.PRIVATE;
                currentResult.isPersonal = currentResult.visibility === api.visibility.PERSONAL;
                currentResult.isPublic = currentResult.visibility === api.visibility.PUBLIC;

                // Calculated fields to make rendering easier
                currentResult.fromSomeoneYouFollow = currentResult.user.user.toString() !== user.toString();
                currentResult.isLike = currentResult.type === 'like';
                currentResult.isPost = currentResult.type === 'post';
                currentResult.isFollow = currentResult.type === 'follow';
                currentResult.isFriend = currentResult.type === 'friend';

                var currentUserIsUser = liu && currentResult.user.user.toString() === liu.toString();
                var currentUserIsFollower = liu && currentResult.user_follower ? currentResult.user_follower.user.toString() === liu.toString() : false;
                currentResult.isUsersItem = currentUserIsUser || currentUserIsFollower;
                currentResult.isFollower = currentUserIsFollower;

                feed.push(currentResult);
              }
            });

            next(null, feed, nextPageState);
          });
        });
      } else {
        if (err) { return next(err); }
        next(null, []);
      }
    });
  }

  function seedFeed (keyspace, user, userFollowing, backfill, follow, next) {
    var feedOptions = {pageSize: Number(backfill), type: 'post'};
    getReversedUserFeed(keyspace, user, userFollowing, feedOptions, function (err, feed) {
      if (err) { return next(err); }
      async.map(feed, function (item, cb) {
        if (item.visibility !== api.visibility.PUBLIC) return cb();
        upsertTimeline(keyspace, 'feed_timeline', user, item.item, item.type, item.time, item.visibility, follow.follow, cb);
      }, next);
    });
  }

  return {
    addFeedItem: addFeedItem,
    removeFeedsForItem: removeFeedsForItem,
    removeFeedsOlderThan: removeFeedsOlderThan,
    insertFollowersTimeline: insertFollowersTimeline,
    insertMentionedTimeline: insertMentionedTimeline,
    upsertTimeline: upsertTimeline,
    getFeed: getFeed,
    getUserFeed: getUserFeed,
    getRawFeed: getRawFeed,
    seedFeed: seedFeed
  };
};
