import nextConnect from 'next-connect';
import multer from 'multer';
import axios from 'axios';
const { MongoClient } = require('mongodb');
const ImageKit = require('imagekit');
const { DateTime } = require('luxon');
let dbUri = process.env.DB_USER && process.env.DB_PASS ? `${process.env.DB_USER}:${process.env.DB_PASS}@` : '';
const scheme = process.env.DB_PASS ? '+srv' : '';
dbUri = `mongodb${scheme}://${dbUri}${process.env.DB_HOST}/${process.env.DB_NAME}?retryWrites=true&w=majority`;
const client = new MongoClient(dbUri);
const { Client: MapsClient } = require('@googlemaps/google-maps-services-js');
client.connect();

const apiRoute = nextConnect({
  // Handle any other HTTP method
  onNoMatch(req, res) {
    res.status(405).json({ error: `Method '${req.method}' Not Allowed` });
  },
});
apiRoute.use(multer({}).any());

apiRoute.get(async (req, res) => {
  const result = await client.db('track').collection('checkins').find({}).sort('created_at', 'desc').toArray();
  res.json({ success: true, data: result });
});

const getTimeZone = async (lat, lon, seconds) => {
  const gUrl = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat}%2C${lon}&timestamp=${seconds}&key=${process.env.GOOGLE_API_SERVER_KEY}`;
  const res = await axios(gUrl);
  if (res?.data?.timeZoneId) {
    throw Error('Missing Timezone');
  }
  return res.data.timeZoneId;
};

const getCountry = async (lat, lon) => {
  const gClient = new MapsClient({});
  const resp = await gClient.reverseGeocode({
    params: {
      latlng: {
        lat,
        lng: lon,
      },
      key: process.env.GOOGLE_API_SERVER_KEY,
    },
  });
  if (!(resp?.data?.results?.length >= 2)) {
    throw new Error('Missing places result');
  }
  const res = {};
  const country = resp.data.results[resp.data.results.length - 1];
  const area = resp.data.results[resp.data.results.length - 2];

  if (country?.types?.includes('country')) {
    res.country = country.formatted_address;
  }
  if (area?.types?.includes('locality')) {
    res.city = area.address_components[0].long_name;
  }
  if (!res.city && area?.types?.includes('administrative_area_level_1')) {
    res.area = area.address_components[0].long_name;
  }
  if (!res.country || (!res.city && !res.area)) {
    throw Error('Missing area data');
  }
  return res;
};

const uploadPhoto = async (file) => {
  const imagekit = new ImageKit({
    publicKey: process.env.KIT_KEY_PUB,
    privateKey: process.env.KIT_KEY_PRIV,
    urlEndpoint: process.env.KIT_URL,
  });
  const res = await imagekit.upload({
    file,
    fileName: `pic-${new Date().toLocaleString()}.jpg`,
  });
  if (!res?.url) {
    throw new Error('Missing Image');
  }
  return res.url;
};

const saveCheckin = async (lat, lon, altitude, text, timeIso, photo) => {
  if (!DateTime.fromISO(timeIso).isValid) {
    throw Error('Invalid time');
  }
  const time = new Date(timeIso);
  let doc = {
    location: {
      lat,
      lon,
    },
    time,
  };
  if (altitude > 0) {
    doc.altitude = altitude;
  }
  if (!doc.location.lat || !doc.location.lon) {
    throw Error('Missing Location');
  }
  doc.timezone = await getTimeZone(doc.location.lat, doc.location.lon, time.getUTCSeconds());
  if (!doc.timezone) {
    doc.time_local = timeIso;
  }
  const areaData = await getCountry(doc.location.lat, doc.location.lon);
  doc = { ...doc, ...areaData };
  if (photo) {
    doc.image = await uploadPhoto(photo.buffer);
  }
  if (text) {
    doc.text_entry = text;
  }
  const dbRes = await client.db('track').collection('checkins').insertOne(doc);
  if (!dbRes?.insertedId) {
    throw Error('Error inserting in DB');
  }
};

apiRoute.post(async (req, res) => {
  try {
    // const locs = [[13.779079297605545, 100.5196700105414]];
    // const time = new Date();
    // for (let i = 0; i < locs.length; i++) {
    //   await saveCheckin(locs[i][0], locs[i][1], 1, 'no', new Date(time.toISOString()), undefined);
    // }
    const lat = parseFloat(req.body.lat);
    const lon = parseFloat(req.body.lon);
    const altitude = parseFloat(req.body.altitude?.replace(',', '.'));
    const text = req.body?.text?.length && req.body.text !== 'no' ? req.body.text : undefined;
    const photo = req?.files?.length === 1 ? req.files[0] : undefined;

    await saveCheckin(lat, lon, altitude, text, req.body?.time, photo);
    res.status(200).send('ok');
  } catch (e) {
    res.status(400).send(e.message);
  }
});

export default apiRoute;

export const config = {
  api: {
    bodyParser: false,
  },
};
