const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function createAdminUser() {
  const name = randomName();
  const user = { name, email: name + '@admin.com', password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

async function loginUser(user) {
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(res.status).toBe(200);
  return res.body;
}

async function createDiner() {
  const user = { name: randomName(), password: 'a' };
  user.email = user.name + '@diner.com';
  
  const res = await request(app).post('/api/auth').send(user);
  expect(res.status).toBe(200);
  return { user: res.body.user, token: res.body.token, password: 'a' };
}

test('you can look up your own info', async () => {
  const diner = await createDiner();
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${diner.token}`);
  expect(res.body.id).toBe(diner.user.id);
  expect(res.body.email).toBe(diner.user.email);
  expect(res.body.roles).toMatchObject([{ role: 'diner' }]);
});

test('no token, no info', async () => {
  const res = await request(app).get('/api/user/me');
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('unauthorized');
});

test('you can change your own name and email', async () => {
  const diner = await createDiner();
  const newEmail = randomName() + '@diner.com';

  const res = await request(app)
    .put(`/api/user/${diner.user.id}`)
    .set('Authorization', `Bearer ${diner.token}`)
    .send({ name: 'updated diner', email: newEmail, password: 'b' });

  expect(res.status).toBe(200);
  expect(res.body.user.name).toBe('updated diner');
  expect(res.body.user.email).toBe(newEmail);

  await loginUser({ email: newEmail, password: 'b' }); // The new credentials work
});

test('you cannot go messing with someone else account', async () => {
  const diner = await createDiner();
  const victim = await createDiner();

  const res = await request(app)
    .put(`/api/user/${victim.user.id}`)
    .set('Authorization', `Bearer ${diner.token}`)
    .send({ name: 'hijacked', email: randomName() + '@diner.com', password: 'b' }); // no cross tenant hijacking. Although you could guess the email

  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unauthorized');
});

test('admins can edit anybody', async () => {
  const admin = await createAdminUser();
  const adminToken = (await loginUser(admin)).token;
  const diner = await createDiner();
  const newEmail = randomName() + '@diner.com';

  const res = await request(app)
    .put(`/api/user/${diner.user.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'admin edited', email: newEmail, password: 'c' });

  expect(res.status).toBe(200);
  expect(res.body.user.name).toBe('admin edited');
});

test('updating without a token gets you nowhere', async () => {
  const res = await request(app).put('/api/user/1').send({ name: 'nope' });
  expect(res.status).toBe(401);
});

test('listing users is still just a stub', async () => {
  const diner = await createDiner();
  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${diner.token}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ message: 'not implemented', users: [], more: false });
});

test('deleting a user is still just a stub', async () => {
  const diner = await createDiner();
  const res = await request(app).delete(`/api/user/${diner.user.id}`).set('Authorization', `Bearer ${diner.token}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('not implemented');
});
