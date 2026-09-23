const request = require('supertest');
const app = require('../service');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

function randomName() {
    return Math.random().toString(36).substring(2, 12);
}

const { Role, DB } = require('../database/database.js');

async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
    jest.setTimeout(60 * 1000 * 5); // 5 minutes
}

test('admin login', async () => {
  const adminUser = await createAdminUser();
  const loginRes = await request(app).put('/api/auth').send(adminUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...adminUser, roles: [{ role: 'admin' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('create user', async () => {
  const user = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(user);
  expect(registerRes.status).toBe(200);
  expectValidJwt(registerRes.body.token);

  const expectedUser = { ...user, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(registerRes.body.user).toMatchObject(expectedUser);
});

test('update user', async () => {
  const user = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(user);
  expect(registerRes.status).toBe(200);
  expectValidJwt(registerRes.body.token);

  const updateRes = await request(app).put('/api/auth').send(user);
  expect(updateRes.status).toBe(200);
  expectValidJwt(updateRes.body.token);

  const expectedUser = { ...user, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(registerRes.body.user).toMatchObject(expectedUser);
});

test('logout', async () => {
  const user = { name: 'pizza diner', email: randomName() + '@test.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(user);
  expect(registerRes.status).toBe(200);
  expectValidJwt(registerRes.body.token);

  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${registerRes.body.token}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body.message).toBe('logout successful');
});

test('logout without a token is unauthorized', async () => {
  const logoutRes = await request(app).delete('/api/auth');
  expect(logoutRes.status).toBe(401);
  expect(logoutRes.body.message).toBe('unauthorized');
});

