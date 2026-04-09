import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('Settings (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/settings should return empty array initially', () => {
    return request(app.getHttpServer())
      .get('/api/settings')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
      });
  });

  it('POST /api/settings should create a setting', () => {
    return request(app.getHttpServer())
      .post('/api/settings')
      .send({ key: 'google_calendar_id', value: 'parents-group' })
      .expect(201)
      .expect((res) => {
        expect(res.body.key).toBe('google_calendar_id');
        expect(res.body.value).toBe('parents-group');
        expect(res.body.id).toBeDefined();
      });
  });

  it('GET /api/settings/:key should return a setting', () => {
    return request(app.getHttpServer())
      .get('/api/settings/google_calendar_id')
      .expect(200)
      .expect((res) => {
        expect(res.body.key).toBe('google_calendar_id');
        expect(res.body.value).toBe('parents-group');
      });
  });

  it('PUT /api/settings/:key should update a setting', () => {
    return request(app.getHttpServer())
      .put('/api/settings/google_calendar_id')
      .send({ value: 'parents-group,school-updates' })
      .expect(200)
      .expect((res) => {
        expect(res.body.value).toBe('parents-group,school-updates');
      });
  });

  it('GET /api/settings/:key should return 404 for nonexistent key', () => {
    return request(app.getHttpServer())
      .get('/api/settings/nonexistent')
      .expect(404);
  });

  it('POST /api/settings should reject invalid data (empty key)', () => {
    return request(app.getHttpServer())
      .post('/api/settings')
      .send({ key: '', value: 'test' })
      .expect(400);
  });

  it('POST /api/settings should reject invalid data (missing value)', () => {
    return request(app.getHttpServer())
      .post('/api/settings')
      .send({ key: 'test' })
      .expect(400);
  });

  it('POST /api/settings should reject extra fields', () => {
    return request(app.getHttpServer())
      .post('/api/settings')
      .send({ key: 'check_schedule', value: 'val', extra: 'nope' })
      .expect(400);
  });

  it('DELETE /api/settings/:key should delete a setting', () => {
    return request(app.getHttpServer())
      .delete('/api/settings/google_calendar_id')
      .expect(200);
  });

  it('DELETE /api/settings/:key should return 404 after deletion', () => {
    return request(app.getHttpServer())
      .delete('/api/settings/google_calendar_id')
      .expect(404);
  });
});
