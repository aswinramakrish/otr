var AES = require('./vendor/aes.js')
  , SHA256 = require('./vendor/sha256.js')
  , HmacSHA256 = require('./vendor/hmac-sha256.js')
  , BigInt = require('./vendor/bigint.js')
  , DH = require('./dh.json')
  , hlp = require('./helpers.js')
  , dsa = require('./dsa.js')

// ctr mode
require('./vendor/mode-ctr.js')(AES)

// otr message states
var MSGSTATE_PLAINTEXT = 0
  , MSGSTATE_ENCRYPTED = 1
  , MSGSTATE_FINISHED = 2

// otr authentication states
var AUTHSTATE_NONE = 0
  , AUTHSTATE_AWAITING_DHKEY = 1
  , AUTHSTATE_AWAITING_REVEALSIG = 2
  , AUTHSTATE_AWAITING_SIG = 3
  , AUTHSTATE_V1_SETUP = 4

// diffie-hellman modulus and generator
// see group 5, RFC 3526
var G = BigInt.str2bigInt(DH.G, 10)
var N = BigInt.str2bigInt(DH.N, 16)
var TWO = BigInt.str2bigInt('2', 10)
var N_MINUS_2 = BigInt.sub(N, TWO)

function checkGroup(g) {
  return hlp.GTOE(g, TWO) && hlp.GTOE(N_MINUS_2, g)
}

function dh() {
  var dh = { privateKey: BigInt.randBigInt(320) }
  dh.publicKey = BigInt.powMod(DH.G, this.privateKey, DH.N)
  return dh
}

module.exports = OTR

function OTR() {
  if (!(this instanceof OTR)) return new OTR()

  this.init()

  // bind methods
  var self = this
  ;['sendMsg', 'receiveMsg'].forEach(function (meth) {
    self[meth] = self[meth].bind(self)
  })
}

OTR.prototype = {

  constructor: OTR,

  init: function () {
    this.msgstate = MSGSTATE_PLAINTEXT
    this.authstate = AUTHSTATE_NONE
    this.ALLOW_V1 = false
    this.ALLOW_V2 = true
    this.keyId = 0
  },

  createAuthKeys: function() {
    var s = BigInt.powMod(this.gy, this.dh.privateKey, N)
    var secbytes = hlp.packMPI(s)
    this.ssid = hlp.h2('0x00', secbytes) & hlp.mask(64)  // first 64-bits
    var tmp = hlp.h2('0x01', secbytes)
    this.c = tmp & hlp.mask(128)  // first 128-bits
    this.c_prime = (tmp >> 128) & hlp.mask(128)  // second 128-bits
    this.m1 = hlp.h2('0x02', secbytes)
    this.m2 = hlp.h2('0x03', secbytes)
    this.m1_prime = hlp.h2('0x04', secbytes)
    this.m2_prime = hlp.h2('0x05', secbytes)
  },

  calculatePubkeyAuth: function(c, m) {
    var pass = HmacSHA256.enc.Latin1.parse(m)
    var hmac = HmacSHA256.algo.HMAC.create(HmacSHA256.algo.SHA256, pass)
    hmac.update(hlp.packMPI(this.dh.publicKey))
    hmac.update(hlp.packMPI(this.gy))
    var pk = this.priv.packPublic()
    hmac.update(pk)
    var kid = hlp.packData(hlp.pack(this.keyId))
    hmac.update(kid)
    var mb = hmac.finalize()
    var xb = pk + kid + dsa.sign(mb.toString(HmacSHA256.enc.Latin1), this.priv)
    var opts = {
        mode: AES.mode.CTR
      , iv: AES.enc.Hex.parse('0')
    }
    var aesctr = AES.AES.encrypt(xb, c, opts)
    return aesctr.toString(AES.enc.Latin1)
  },

  handleAKE: function (msg, cb) {
    var reply = true
      , send = {}

    switch (msg.type) {

      case '0x02':
        // d-h key message
        this.dh = dh()
        send.gy = hlp.packMPI(this.dh.publicKey)
        this.encrypted = msg.encrypted
        this.hashed = msg.hashed
        send.type = '0x0a'
        send.version = '0x0002'
        break

      case '0x0a':
        // reveal signature message
        this.gy = hlp.readMPI(msg.gy)

        // verify gy is legal 2 <= gy <= N-2
        if (!checkGroup(this.gy)) return this.error('Illegal g^y.')

        this.createAuthKeys()
        this.keyId += 1

        send.aesctr = this.calculatePubkeyAuth(this.c, this.m1)

        var pass = HmacSHA256.enc.Latin1.parse(this.m2)
        var mac = HmacSHA256.HmacSHA256(send.aesctr, pass)
        send.mac = mac & hlp.mask(160)

        send.r = hlp.packMPI(this.r)
        send.type = '0x11'
        send.version = '0x0002'
        reply = false
        break

      case '0x11':
        // signature message
        send.type = '0x12'
        send.version = '0x0002'
        break

      case '0x12':
        // data message
        send.type = '0x03'
        send.version = '0x0002'
        break

      default:
        this.error('Invalid message type.')
        reply = false

    }

    if (reply) this.sendMsg(send, cb)
  },

  initiateAKE: function (cb) {

    // d-h commit message
    var send = {
       type: '0x02'
     , version: '0x0002'
    }

    this.dh = dh()
    var gxmpi = hlp.packMPI(this.dh.publicKey)

    this.r = hlp.randomValue()
    var key = AES.enc.Hex.parse(BigInt.bigInt2str(this.r, 16))
    var opts = {
        mode: AES.mode.CTR
      , iv: AES.enc.Hex.parse('0')
    }

    var encrypt = AES.AES.encrypt(gxmpi, key, opts)
    send.encrypted = encrypt.toString(AES.enc.Latin1)

    var hash = SHA256.SHA256(gxmpi)
    send.hashed = hash.toString(SHA256.enc.Latin1)

    this.sendMsg(send, cb)

  },

  sendMsg: function (send, cb) {
    console.log('sending')
    cb(send, this.receiveMsg)
  },

  receiveMsg: function (msg, cb) {
    if (typeof cb !== 'function')
      throw new Error('Nowhere to go?')

    this.handleAKE(msg, cb)
  },

  error: function (err) {
    console.log(err)
  }

}