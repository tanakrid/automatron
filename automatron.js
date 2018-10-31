const express = require('express')
const Webtask = require('webtask-tools')
const mqtt = require('mqtt')
const bodyParser = require('body-parser')
const middleware = require('@line/bot-sdk').middleware
const Client = require('@line/bot-sdk').Client
const app = express()
const axios = require('axios')

/**
 * @param {WebtaskContext} context
 * @param {string} message
 */
async function handleTextMessage(context, message) {
  if (message === 'ac on' || message === 'sticker:2:27') {
    await sendHomeCommand(context, 'ac on')
    return 'ok, turning air-con on'
  } else if (message === 'ac off' || message === 'sticker:2:29') {
    await sendHomeCommand(context, 'ac off')
    return 'ok, turning air-con off'
  } else if (message === 'power on' || message === 'plugs on') {
    await sendHomeCommand(context, 'plugs on')
    return 'ok, turning smart plugs on'
  } else if (message === 'power off' || message === 'plugs off') {
    await sendHomeCommand(context, 'plugs off')
    return 'ok, turning smart plugs off'
  } else if (message === 'home' || message === 'arriving' || message === 'sticker:2:503') {
    await sendHomeCommand(context, ['plugs on', 'lights on', 'ac on'])
    return 'preparing home'
  } else if (message === 'leaving' || message === 'sticker:2:502') {
    await sendHomeCommand(context, ['plugs off', 'lights off', 'ac off'])
    return 'bye'
  } else if (message === 'lights' || message === 'sticker:4:275') {
    await sendHomeCommand(context, 'lights normal')
    return 'ok, lights normal'
  } else if (message === 'lights' || message === 'sticker:11539:52114128') {
    await sendHomeCommand(context, 'lights bedtime')
    return 'ok, good night'
  } else if (message.match(/^lights \w+$/)) {
    const cmd = message.split(' ')[1]
    await sendHomeCommand(context, 'lights ' + cmd)
    return 'ok, lights ' + cmd
  } else if (message.match(/^[\d.]+[tfghmo]$/i)) {
    const m = message.match(/^([\d.]+)([tfghmo])$/i)
    const amount = Math.round(+m[1], 2)
    const category = {
      t: 'transportation',
      f: 'food',
      g: 'game',
      h: 'health',
      m: 'miscellaneous',
      o: 'occasion'
    }[m[2].toLowerCase()]
    await recordExpense(context, category, amount)
    return createBubble('expense tracking', `recorded expense ฿${amount} ${category}`)
  } else if (message.startsWith('>')) {
    const code = require('livescript').compile(message.substr(1), { bare: true })
    console.log('Code compilation result', code)
    const runner = new Function('prelude', 'code', 'context', 'with(prelude){return eval(code)}')
    const result = require('util').inspect(runner(require('prelude-ls'), code, context))
    return createBubble('livescript', result, {
      headerBackground: '#37BF00',
      headerColor: '#ffffff',
      textSize: 'sm'
    })
  }
  return 'unrecognized message! ' + message
}

// ==== SERVICE FUNCTIONS ====

/**
 * @param {WebtaskContext} context
 * @param {string | string[]} cmd
 */
async function sendHomeCommand(context, cmd) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    var client = mqtt.connect(context.secrets.MQTT_URL);
    client.on('connect', function () {
      if (Array.isArray(cmd)) {
        cmd.forEach(c => client.publish('home', c));
      } else {
        client.publish('home', cmd);
      }
      console.log('Finish sending command', cmd, Date.now() - start)
      client.end(false, resolve);
    });
    client.on('error', function (error) {
      reject(error);
    });
  });
}

/**
 * @param {WebtaskContext} context
 * @param {string} category
 * @param {string} amount
 */
async function recordExpense(context, amount, category) {
  await axios.post(context.secrets.EXPENSE_WEBHOOK, {
    value1: new Date().toJSON().split('T')[0],
    value2: amount,
    value3: category,
  })
}

// ==== RUNTIME CODE ====

/**
 * @param {WebtaskContext} context
 * @param {import('@line/bot-sdk').WebhookEvent[]} events
 * @param {import('@line/bot-sdk').Client} client
 */
async function handleWebhook(context, events, client) {
  async function main() {
    for (const event of events) {
      if (event.type === 'message') {
        await handleMessageEvent(event)
      }
    }
  }

  async function handleMessageEvent(event) {
    const { replyToken, message } = event
    console.log(event)
    if (event.source.userId !== context.secrets.LINE_USER_ID) {
      await client.replyMessage(replyToken, toMessages('unauthorized'))
      return
    }
    if (message.type === 'text') {
      let reply
      try {
        reply = await handleTextMessage(context, message.text)
      } catch (e) {
        reply = createErrorMessage(e)
      }
      await client.replyMessage(replyToken, toMessages(reply))
    } else if (message.type === 'sticker') {
      let reply
      try {
        reply = await handleTextMessage(context, 'sticker:' + message.packageId + ':' + message.stickerId)
      } catch (e) {
        reply = createErrorMessage(e)
      }
      await client.replyMessage(replyToken, toMessages(reply))
    } else {
      await client.replyMessage(replyToken, [
        { type: 'text', text: 'don’t know how to handle this yet!' }
      ])
    }
  }

  return main()
}

app.post('/webhook', (req, res, next) => {
  const lineConfig = getLineConfig(req)
  const context = req.webtaskContext
  middleware(lineConfig)(req, res, async err => {
    if (err) return next(err)
    try {
      const client = new Client(lineConfig)
      const data = await handleWebhook(context, req.body.events, client)
      console.log('Response:', data)
      res.json({ ok: true, data })
    } catch (e) {
      try {
        logError(e)
        await client.pushMessage(context.secrets.LINE_USER_ID, createErrorMessage(e))
      } finally {
        return next(e)
      }
    }
  })
})

app.post('/post', require('body-parser').json(), async (req, res, next) => {
  const context = req.webtaskContext
  try {
    if (req.body.key !== context.secrets.API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' })
    }
    const lineConfig = getLineConfig(req)
    const client = new Client(lineConfig)
    const messages = toMessages(req.body.data)
    await client.pushMessage(context.secrets.LINE_USER_ID, messages)
    res.json({ ok: true })
  } catch (e) {
    try {
      logError(e)
      await client.pushMessage(context.secrets.LINE_USER_ID, createErrorMessage(e))
    } finally {
      return next(e)
    }
  }
})

app.post('/text', require('body-parser').json(), async (req, res, next) => {
  const context = req.webtaskContext
  try {
    if (req.body.key !== context.secrets.API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' })
    }
    const text = String(req.body.text)
    const lineConfig = getLineConfig(req)
    const client = new Client(lineConfig)
    await client.pushMessage(context.secrets.LINE_USER_ID, toMessages('received: ' + text + ` [from ${req.body.source}]`))
    let reply
    let error
    try {
      reply = await handleTextMessage(context, text)
    } catch (e) {
      reply = createErrorMessage(e)
      error = e
    }
    await client.pushMessage(context.secrets.LINE_USER_ID, toMessages(reply))
    res.json({ ok: !error, reply })
  } catch (e) {
    try {
      logError(e)
      await client.pushMessage(context.secrets.LINE_USER_ID, createErrorMessage(e))
    } finally {
      return next(e)
    }
  }
})

function logError(e) {
  var response = e.response || (e.originalError && e.originalError.response)
  var data = response && response.data
  if (data) {
    console.error('HTTP error data', data)
  }
}

function toMessages(data) {
  if (!data) data = '...'
  if (typeof data === 'string') data = [{ type: 'text', text: data }]
  return data
}

function getLineConfig(req) {
  const ctx = req.webtaskContext
  return {
    channelAccessToken: ctx.secrets.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: ctx.secrets.LINE_CHANNEL_SECRET
  }
}

function createErrorMessage(error) {
  const title = (error.name || 'Error') + (error.message ? `: ${error.message}` : '')
  return createBubble(title, String(error.stack || error), {
    headerBackground: '#E82822',
    headerColor: '#ffffff',
    textSize: 'sm'
  })
}

function createBubble(title, text, {
  headerBackground = '#353433',
  headerColor = '#d7fc70',
  textSize = 'xl'
} = {}) {
  const data = {
    "type": "bubble",
    "styles": {
      "header": {
        "backgroundColor": headerBackground
      }
    },
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": title,
          "color": headerColor,
          "weight": "bold"
        }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        {
          "type": "text",
          "text": text,
          "wrap": true,
          "size": textSize
        }
      ]
    }
  }
  return { type: 'flex', altText: truncate(`[${title}] ${text}`, 400), contents: data }
}

function truncate(text, maxLength) {
  return text.length + 5 > maxLength ? text.substr(0, maxLength - 5) + '…' : text
}

module.exports = Webtask.fromExpress(app)
