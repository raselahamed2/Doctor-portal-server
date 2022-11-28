const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const portal = process.env.PORT || 5000;
const jwt = require('jsonwebtoken');
const { query } = require('express');
require('dotenv').config()
const stripe = require("stripe")(process.env.SECRET_KEY);

const app = express()

app.use(cors())
app.use(express.json())


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ni7npsp.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJwt(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.send(401).send('unauthorized token')
    }

    const token = authHeader.split(' ')[1]

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded
        next()
    })
}

async function run() {
    try {
        const drAppointmentCollection = client.db('doctorPortal').collection('drAppointment')
        const bookingsCollection = client.db('doctorPortal').collection('bookings')
        const usersCollection = client.db('doctorPortal').collection('users')
        const doctorsCollection = client.db('doctorPortal').collection('doctors')
        const paymentsCollection = client.db('doctorPortal').collection('payments')

        const verifyAdmin = async (req, res, next) => {
            console.log('make sure admin', req.params.email);
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next()
        }

        app.get('/appointmentOption', async (req, res) => {
            const date = req.query.date;
            const query = {}
            const options = await drAppointmentCollection.find(query).toArray()
            const bookingQuery = { appointmentDate: date };
            const alredyBooked = await bookingsCollection.find(bookingQuery).toArray();
            options.forEach(option => {
                const optionBooked = alredyBooked.filter(book => book.treatmant === option.name)
                const bookedSlots = optionBooked.map(book => book.slot);
                const reminingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = reminingSlots
            })
            res.send(options)
        })

        app.get(('/v2/appointmentOption', async (req, res) => {
            const date = req.query.data
            const options = await drAppointmentCollection.aggregate([
                {
                    $lokup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatmant',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: 'booked',
                                as: 'as',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray()
            res.send(options)
        }))

        app.get('/appointmentSpecitalty', async (req, res) => {
            const query = {}
            const result = await drAppointmentCollection.find(query).project({ name: 1 }).toArray()
            res.send(result)
        })

        app.get('/bookings', verifyJwt, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            console.log(email, decodedEmail);
            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email }
            const booking = await bookingsCollection.find(query).toArray();
            res.send(booking)
        })

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) }
            const booking = await bookingsCollection.findOne(query);
            res.send(booking)
        })

        app.post('/bookings', async (req, res) => {
            const bookings = req.body
            const query = {
                appointmentDate: bookings.appointmentDate,
                email: bookings.email,
                treatmant: bookings.treatmant
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if (alreadyBooked.length) {
                const message = `You alredy booking ${bookings.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }

            const result = await bookingsCollection.insertOne(bookings)
            res.send(result)
        })

        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email }
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '3d' })
                return res.send({ accessToken: token })
            }
            else {
                res.status(403).send({ accessToken: '' })
            }
        })

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email }
            const user = await usersCollection.findOne(query)
            res.send({ isAdmin: user?.role === 'admin' })
        })

        app.get('/users', async (req, res) => {
            const query = {}
            const users = await usersCollection.find(query).toArray()
            res.send(users)
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result)
        })

        app.put('/users/admin/:id', verifyJwt, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const filter = { _id: ObjectId(id) }
            const options = { upsert: true }
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options)
            res.send(result)
        })

        app.get('/addPrice', async (req, res) => {
            const filter = {}
            const options = { upsert: true }
            const updatedDoc = {
                $set: {
                    price: 99
                }
            }
            const result = await drAppointmentCollection.updateMany(filter, updatedDoc, options)
            res.send(result)
        })

        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100
            const paymentIntent = await stripe.paymentIntents.create({
                currency: "usd",
                amount: amount,
                "payment_method_types": [
                    "card"
                  ],
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
              });
        })

        app.post('/payments', async(req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            console.log(id);
            const filter = {_id: ObjectId(id)}
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updateResult = await bookingsCollection.updateOne(filter, updatedDoc);
            console.log(updateResult);
            res.send(result)
            
        })

        app.get('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
            const query = req.body;
            const doctors = await doctorsCollection.find(query).toArray()
            res.send(doctors)
        })

        app.post('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor)
            res.send(result)
        })

        app.delete('/doctors/:id', verifyJwt, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) }
            const result = await doctorsCollection.deleteOne(filter)
            res.send(result)
        })

    }
    finally {

    }
}

run().catch(e => console.log(e))


app.get('/', async (req, res) => {
    res.send('server is running')
})

app.listen(portal, () => console.log(`doctor portal server is running ${portal}`))