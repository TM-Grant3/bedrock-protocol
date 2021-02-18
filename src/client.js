const RakClient = require('jsp-raknet/client')
const { Connection } = require('./connection')
const { createDeserializer, createSerializer } = require('./transforms/serializer')
const ConnWorker = require('./ConnWorker')
const { Encrypt } = require('./auth/encryption')
const auth = require('./client/auth')
const Options = require('./options')
const debug = require('debug')('minecraft-protocol')
const fs = require('fs')

const log = console.log
const useWorkers = true

class Client extends Connection {
  constructor(options) {
    super()
    this.options = { ...Options.defaultOptions, options }
    this.serializer = createSerializer()
    this.deserializer = createDeserializer()
    this.validateOptions()

    Encrypt(this, null, options)

    if (options.password) {
      auth.authenticatePassword(this, options)
    } else {
      auth.authenticateDeviceCode(this, options)
    }

    this.on('session', this.connect)
    // this.on('decrypted', this.onDecryptedPacket)
  }

  validateOptions() {
    if (this.options.version < Options.MIN_VERSION) {
      throw new Error(`Unsupported protocol version < ${Options.MIN_VERSION} : ${this.options.version}`)
    }
  }

  onEncapsulated = (encapsulated, inetAddr) => {
    // log(inetAddr.address, ': Encapsulated', encapsulated)
    const buffer = Buffer.from(encapsulated.buffer)
    this.handle(buffer)
  }

  connect = async (sessionData) => {
    if (useWorkers) {
      this.worker = ConnWorker.connect('127.0.0.1', 19132)
      this.worker.on('message', (evt) => {
        switch (evt.type) {
          case 'connected':
            this.sendLogin()
            break
          case 'encapsulated':
            this.onEncapsulated(...evt.args)
            break
        }
      })

    } else {
      if (this.raknet) return

      this.raknet = new RakClient('127.0.0.1', 19132)
      await this.raknet.connect()

      this.raknet.on('connecting', () => {
        // console.log(`[client] connecting to ${hostname}/${port}`)
      })
      this.raknet.on('connected', (connection) => {
        console.log(`[client] connected!`)
        this.connection = connection
        this.sendLogin()
      })

      this.raknet.on('encapsulated', this.onEncapsulated)

      this.raknet.on('raw', (buffer, inetAddr) => {
        console.log('Raw packet', buffer, inetAddr)
      })
    }

  }

  sendLogin() {
    this.createClientChain()

    const chain = [
      this.clientIdentityChain, // JWT we generated for auth
      ...this.accessToken // Mojang + Xbox JWT from auth
    ]

    const encodedChain = JSON.stringify({ chain })
    const skinChain = JSON.stringify({})

    const bodyLength = this.clientUserChain.length + encodedChain.length + 8

    debug('Auth chain', chain)

    this.write('login', {
      protocol_version: this.options.version,
      payload_size: bodyLength,
      chain: encodedChain,
      client_data: this.clientUserChain
    })
  }

  // After sending Server to Client Handshake, this handles the client's
  // Client to Server handshake response. This indicates successful encryption
  onHandshake() {
    // https://wiki.vg/Bedrock_Protocol#Play_Status
    this.write('play_status', { status: PLAY_STATUS.LoginSuccess })
    this.emit('join')
  }

  onDisconnectRequest(packet) {
    // We're talking over UDP, so there is no connection to close, instead
    // we stop communicating with the server
    console.warn(`Server requested ${packet.hide_disconnect_reason ? 'silent disconnect' : 'disconnect'}: ${packet.message}`)
    process.exit(1)
  }

  readPacket(packet) {
    // console.log('packet', packet)
    const des = this.deserializer.parsePacketBuffer(packet)
    const pakData = { name: des.data.name, params: des.data.params }
    console.log('->', pakData.name, serialize(pakData.params).slice(0, 100))
    // console.info('->', JSON.stringify(pakData, (k,v) => typeof v == 'bigint' ? v.toString() : v))
    try {
      if (!fs.existsSync(`./packets/${pakData.name}.json`)) {
        fs.writeFileSync(`./packets/${pakData.name}.json`, serialize(pakData.params, 2))
        fs.writeFileSync(`./packets/${pakData.name}.txt`, packet.toString('hex'))
      }
    } catch {}
    switch (des.data.name) {
      case 'server_to_client_handshake':
        this.emit('client.server_handshake', des.data.params)
        break
      case 'disconnect': // Client kicked
        this.onDisconnectRequest(des.data.params)
        break
      case 'crafting_data':
        fs.writeFileSync('crafting.json', JSON.stringify(des.data.params, (k, v) => typeof v == 'bigint' ? v.toString() : v))
        break
      case 'start_game':
        fs.writeFileSync('start_game.json', JSON.stringify(des.data.params, (k, v) => typeof v == 'bigint' ? v.toString() : v))
      default:
      // console.log('Sending to listeners')
    }
    this.emit(des.data.name, des.data.params)

  }
}

function serialize(obj = {}, fmt) {
  return JSON.stringify(obj, (k, v) => typeof v == 'bigint' ? v.toString() : v, fmt)
}

module.exports = { Client }