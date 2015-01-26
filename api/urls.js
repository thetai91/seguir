/**
 * Templates for the urls shared between client and server
 */
var st = require('string-template');
var _ = require('lodash');

var urls = {
  addUser:                    '/user',
  getUser:                    '/user/:user',
  getUserByName:              '/username/:username',
  getUserRelationship:        '/user/:user/relationship',
  addPost:                    '/post',
  getPost:                    '/post/:post',
  addFriend:                  '/friend',
  getFriend:                  '/friend/:friend',
  getFriends:                 '/user/:user/friends',
  addFriendRequest:           '/friend-request',
  getFriendRequests:          '/friend-request/active',
  acceptFriendRequest:        '/friend-request/accept',
  addFollower:                '/follower',
  getFollow:                  '/follower/:follow',
  getFollowers:               '/user/:user/followers',
  addLike:                    '/like',
  getLike:                    '/like/:like',
  checkLike:                  '/user/:user/like/:item',
  getFeed:                    '/feed/:user'
}

module.exports = function(url, data) {
  if(urls[url]) {
    if(data) {
      var pattern = urls[url];
      _.keys(data).forEach(function(key) {
        pattern = pattern.replace(':' + key, data[key]);
      });
      return pattern;
    } else {
      return urls[url];
    }
  } else {
    console.log('Unable to locate URL: ' + url);
  }
}

