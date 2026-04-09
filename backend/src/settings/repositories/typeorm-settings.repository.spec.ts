import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TypeOrmSettingsRepository } from './typeorm-settings.repository';
import { UserSettingEntity } from '../entities/user-setting.entity';

describe('TypeOrmSettingsRepository', () => {
  let repository: TypeOrmSettingsRepository;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [UserSettingEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([UserSettingEntity]),
      ],
      providers: [TypeOrmSettingsRepository],
    }).compile();

    repository = module.get<TypeOrmSettingsRepository>(
      TypeOrmSettingsRepository,
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('should upsert and find a setting', async () => {
    const setting = await repository.upsert('theme', 'dark');
    expect(setting.key).toBe('theme');
    expect(setting.value).toBe('dark');

    const found = await repository.findByKey('theme');
    expect(found).toBeDefined();
    expect(found!.value).toBe('dark');
  });

  it('should update an existing setting on upsert', async () => {
    await repository.upsert('theme', 'dark');
    const updated = await repository.upsert('theme', 'light');
    expect(updated.value).toBe('light');

    const all = await repository.findAll();
    expect(all).toHaveLength(1);
  });

  it('should delete a setting', async () => {
    await repository.upsert('theme', 'dark');
    await repository.delete('theme');
    const found = await repository.findByKey('theme');
    expect(found).toBeNull();
  });
});
