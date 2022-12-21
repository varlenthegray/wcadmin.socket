require('dotenv').config({path:'/home/socket/public_html/.env'});
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const bodyParser = require("body-parser");
const { Server } = require("socket.io");

console.log('Environment DB: ', process.env.PG_DB_NAME)

const io = new Server(server, {
    cors: {
        origin: ['https://admin.wcwater.com', 'https://wcadev.innovated.tech']
    }
});

const { createAdapter } = require("@socket.io/postgres-adapter");
const { Pool } = require("pg");

const key = process.env.TELNYX_API_KEY;
let telnyx = require('telnyx')(key);
const from_number = process.env.TELNYX_FROM_NUMBER;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const pool = new Pool({
    host: process.env.PG_DB_HOST,
    database: process.env.PG_DB_NAME,
    user: process.env.PG_DB_USER,
    password: process.env.PG_DB_PASSWORD,
    port: process.env.PG_DB_PORT,
});

io.adapter(createAdapter(pool));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.post('/webhook', (req, res) => {
    let queryLogHook = `INSERT INTO communication_textwebhookmessage (received_at, payload) VALUES (now(), $1::jsonb)`;
    let queryLogHookValues = [req.body];

    pool.query(queryLogHook, queryLogHookValues);

    let from, to, body, num_media, media, direction, message_uid;
    let payload = req.body.data.payload;

    // console.log(payload);

    from = payload.from.phone_number;
    to = payload.to[0].phone_number;
    body = payload.text;
    num_media = payload.media.length;
    media = JSON.stringify(payload.media);
    direction = payload.direction;
    message_uid = payload.id;

    if(direction === 'outbound') {
        direction = 'sent';
    } else {
        direction = 'received';
    }

    let queryFindService = `SELECT id AS client_id, display_name
                            FROM clients_client WHERE
                                main_phone = $1 OR main_phone = $2 OR
                                alternate_phone = $1 OR alternate_phone = $2 OR
                                other_phone = $1 OR other_phone = $2`;
    let queryFindServiceValues = [from, to]

    // console.log(queryFindService);

    pool.query(queryFindService, queryFindServiceValues, (err, res) => {
        if(err) throw err;

        let db_client = res.rows[0];
        let queued, client_id;

        queued = !!payload.completed_at;

        if(db_client) {
            client_id = db_client.client_id;
        } else {
            client_id = null;
        }

        let queryText = `
            INSERT INTO communication_textmessage (from_phone, to_phone, message, direction, read, timestamp, media_count, media, client_id, queued, message_uid)
            VALUES ($1, $2, $3, '${direction}', False, now(), $4, $5, ${client_id}, ${queued}, $6)
            ON CONFLICT (message_uid) DO UPDATE SET queued = ${queued}`;

        let queryValues = [from, to, body, num_media, media, message_uid];

        pool.query(queryText, queryValues, (err, res) => {
            if(err) throw err;
            io.emit('received message', payload, db_client);
        });

        io.emit('update notifications', db_client, payload);
    });

    res.end();
});

io.on('connection', (socket) => {
    console.log('a user connected');

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });

    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });

    socket.on('send text message', (msg, phone) => {
        telnyx.messages
            .create({
                text: msg,
                from: from_number,
                to: phone
            }, function(err, res) {
                if(err) throw err;
            });
    });

    socket.on('mark client texts read', (phone) => {
        if(phone) {
            let queryUnread = `SELECT * FROM communication_textmessage WHERE from_phone = $1 OR to_phone = $1 AND read = FALSE`;
            let queryUnreadValues = [phone]

            pool.query(queryUnread, queryUnreadValues, (err, res) => {
                if(res.rows) {
                    io.emit('client texts read', res.rows);
                }

                let queryMessage = `UPDATE communication_textmessage SET read = TRUE WHERE from_phone = $1 OR to_phone = $1 AND read = FALSE`;
                let queryValues = [phone]

                pool.query(queryMessage, queryValues);
            });
        }
    });
});

server.listen(3002, () => {
    console.log('Server listening on *:3002')
});