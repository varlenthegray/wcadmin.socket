//? switch when trying to activate dev server
require('dotenv').config({path:'/home/socket/public_html/.env'}); // live
// require('dotenv').config({path:'/home/socketdev/public_html/.env'}); // dev
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

let sent_user;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Handle POST requests to '/webhook'
app.post('/webhook', (req, res) => {

    // SQL query to log the received webhook payload into database
    let queryLogHook = `INSERT INTO communication_textwebhookmessage (received_at, payload) VALUES (now(), $1::jsonb)`;

    // Bind values to the above query, where $1 denotes the first parameter after the query string. In this case, the payload received from webhook is be bound to $1
    let queryLogHookValues = [req.body];

    // Execute the above SQL query using a connection pool (pool is an instance of a created postgresql pool)
    pool.query(queryLogHook, queryLogHookValues);

    // Extract from, to, body, num_media, media, direction, message_uid from the webhook payload
    let from, to, body, num_media, media, direction, message_uid;
    let payload = req.body.data.payload;

    from = payload.from.phone_number;
    to = payload.to[0].phone_number;
    body = payload.text;
    num_media = payload.media.length;
    media = JSON.stringify(payload.media);
    direction = payload.direction;
    message_uid = payload.id;

    // If direction is outbound, change it to 'sent', otherwise it's 'received'
    if(direction === 'outbound') {
        direction = 'sent';
    } else {
        direction = 'received';
    }

    // SQL query to find the client_id and display_name based on the phone numbers used for messaging. The query searches for a match in the main_phone, alternate_phone, and other_phone columns of the clients_client table.
    let queryFindService = `SELECT id AS record_id, display_name
                            FROM service_servicerecord WHERE
                                main_phone = $1 OR main_phone = $2 OR
                                alternate_phone = $1 OR alternate_phone = $2 OR
                                other_phone = $1 OR other_phone = $2`;

    // Bind 'from' and 'to' values to queryFindService
    let queryFindServiceValues = [from, to]

    // Execute the above SQL query using a connection pool. The res parameter in the callback function is the result of the query execution.
    pool.query(queryFindService, queryFindServiceValues, (err, res) => {
        try {
            if(err) {
                console.error(err);
                return;
            }

            // Assigns the first row of the returned result to the db_client variable
            let db_record = res.rows[0];

            // queued is set to True if 'completed_at' exists in the payload, otherwise False
            let queued = !!payload.completed_at;
            let record_id;

            if(db_record) {
                // If a matching client exists, set client_id to the id of that client
                record_id = db_record.record_id;
            } else {
                // Otherwise, set client_id to null
                record_id = null;
            }

            // SQL query to insert text message data into communication_textmessage table. 'ON CONFLICT' is used to update the 'queued' field if there is already an existing record with the same message_uid value (i.e., this message has been previously processed).
            let queryText = `
                INSERT INTO communication_textmessage (from_phone, to_phone, message, direction, read, timestamp, media_count, media, record_id, queued, message_uid, sent_by_id, alerted_by_email)
                VALUES ($1, $2, $3, '${direction}', False, now(), $4, $5, ${record_id}, ${queued}, $6, $7, false)
                ON CONFLICT (message_uid) DO UPDATE SET queued = ${queued}`;

            // Bind values to queryText
            let queryValues = [from, to, body, num_media, media, message_uid, sent_user];

            // Execute the above SQL query using a connection pool
            pool.query(queryText, queryValues, (err, res) => {
                try {
                    if(err) {
                        console.error(err);
                        return;
                    }

                    // Emit the 'received message' event to all connected Socket.IO clients along with the payload and the client data (if any)
                    io.emit('received message', payload, db_record);
                } catch (e) {
                    console.error(e);
                }
            });

            // Emit the 'update notifications' event to all connected Socket.IO clients along with the client data (if any) and the payload
            io.emit('update notifications', db_record, payload);
        } catch (e) {
            console.error(e)
        }
    });

    // End the response to the webhook payload
    res.end();
});


io.on('connection', (socket) => {
    // console.log('a user connected');

    socket.on('disconnect', () => {
        // console.log('user disconnected');
    });

    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });

    // listens for the event 'send text message' and expects msg and phone as arguments, as well as optional template and attached_media arguments
    socket.on('send text message', (msg, phone, user_id, template = false, attached_media = false) => {
        if(msg && phone) { // checks that msg and phone are truthy
            if(template) { // if a template argument is provided
                let queryTemplate = `SELECT * FROM communication_textmessagetemplate WHERE id = $1`;
                let queryTemplateValues = [template];

                // queries the database for the template based on its ID
                pool.query(queryTemplate, queryTemplateValues, (err, res) => {
                    try { // tries to execute the following code, catches and logs any errors
                        if(err) {
                            console.error(err);
                            return;
                        }

                        let db_template = res.rows[0];

                        if(db_template['attachment']) { // if the template has an attachment
                            //? sets the media URL to either the live or dev environment based on a comment
                            let media_url = `https://admin.wcwater.com/uploads/${db_template['attachment']}`; // live
                            // let media_url = `https://wcadev.innovated.tech/uploads/${db_template['attachment']}`; // dev

                            try { // tries to send the message with the attached media
                                telnyx.messages.create({
                                    text: msg,
                                    from: from_number,
                                    to: phone,
                                    media_urls: [media_url]
                                }, function(err, res) {
                                    if(err) console.error(err);
                                });
                            } catch (e) { // catches and logs any errors
                                console.error(e);
                            }
                        } else { // if the template does not have an attachment
                            try { // tries to send the message without any media
                                telnyx.messages.create({
                                    text: msg,
                                    from: from_number,
                                    to: phone
                                }, function(err, res) {
                                    if(err) console.error(err);
                                });
                            } catch (e) { // catches and logs any errors
                                console.error(e);
                            }
                        }
                    } catch (e) {
                        console.error(e);
                    }
                });
            } else if(attached_media) { // if an attached_media argument is provided (but not a template)
                try { // tries to send the message with the attached media
                    // console.log(`Attached Media: ` + attached_media)

                    telnyx.messages.create({
                        text: msg,
                        from: from_number,
                        to: phone,
                        media_urls: [attached_media]
                    }, function(err, res) {
                        if(err) console.error(err);
                    });
                } catch (err) { // catches and logs any errors
                    console.error(err);
                }
            } else { // if neither template nor attached_media arguments are provided
                try { // tries to send the message without any media
                    // console.log('Received a message:', msg, ' from ', from_number, ' to ', phone)

                    telnyx.messages.create({
                        text: msg,
                        from: from_number,
                        to: phone
                    }, function(err, res) {
                        if(err) console.error(err);
                    });
                } catch (e) { // catches and logs any errors
                    console.error(e)
                }
            }

            sent_user = user_id; // assigns the user_id value to the variable sent_user
        }
    });


    // Listen to 'mark client texts read' event from client-side
    socket.on('mark client texts read', (phone) => {
        // Check if phone number is provided
        if(phone) {
            // SQL query to select unread messages for the given phone number
            let queryUnread = `SELECT * FROM communication_textmessage WHERE from_phone = $1 OR to_phone = $1 AND read = FALSE`;
            let queryUnreadValues = [phone]

            // Execute the query using Pool object
            pool.query(queryUnread, queryUnreadValues, (err, res) => {
                try {
                    // If there is an error, throw it
                    if(err) {
                        console.error(err);
                        return;
                    }

                    // If there are unread messages, emit 'client texts read' event with the rows data
                    if(res.rows) {
                        io.emit('client texts read', res.rows);
                    }

                    // SQL query to mark the selected messages as read
                    let queryMessage = `UPDATE communication_textmessage SET read = TRUE WHERE from_phone = $1 OR to_phone = $1 AND read = FALSE`;
                    let queryValues = [phone]

                    // Execute the query using Pool object
                    pool.query(queryMessage, queryValues);
                } catch (e) {
                    console.error(e);
                }
            });
        }
    });
});

server.listen(process.env.LISTEN_PORT, () => {
    console.log(`Server listening on *:${process.env.LISTEN_PORT}`);
});