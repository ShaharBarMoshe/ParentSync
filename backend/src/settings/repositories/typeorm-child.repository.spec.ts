import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TypeOrmChildRepository } from './typeorm-child.repository';
import { ChildEntity } from '../entities/child.entity';

describe('TypeOrmChildRepository', () => {
  let repository: TypeOrmChildRepository;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [ChildEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([ChildEntity]),
      ],
      providers: [TypeOrmChildRepository],
    }).compile();

    repository = module.get<TypeOrmChildRepository>(TypeOrmChildRepository);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should create a child and find it by id', async () => {
    const child = await repository.create({
      name: 'Alice',
      channelNames: 'channel-1',
      order: 0,
    });

    expect(child.id).toBeDefined();
    expect(child.name).toBe('Alice');

    const found = await repository.findById(child.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Alice');
  });

  it('should return null for non-existent id', async () => {
    const found = await repository.findById(
      '00000000-0000-0000-0000-000000000000',
    );
    expect(found).toBeNull();
  });

  it('should find all children ordered by order column', async () => {
    await repository.create({ name: 'Charlie', order: 2 });
    await repository.create({ name: 'Alice', order: 0 });
    await repository.create({ name: 'Bob', order: 1 });

    const all = await repository.findAll();
    expect(all).toHaveLength(3);
    expect(all[0].name).toBe('Alice');
    expect(all[1].name).toBe('Bob');
    expect(all[2].name).toBe('Charlie');
  });

  it('should update a child', async () => {
    const child = await repository.create({ name: 'Alice', order: 0 });
    const updated = await repository.update(child.id, { name: 'Alice Updated' });

    expect(updated.name).toBe('Alice Updated');
    expect(updated.id).toBe(child.id);
  });

  it('should delete a child', async () => {
    const child = await repository.create({ name: 'Alice', order: 0 });
    await repository.delete(child.id);

    const found = await repository.findById(child.id);
    expect(found).toBeNull();
  });

  it('should get next order as 0 when no children exist', async () => {
    const nextOrder = await repository.getNextOrder();
    expect(nextOrder).toBe(0);
  });

  it('should get next order based on max existing order', async () => {
    await repository.create({ name: 'Alice', order: 0 });
    await repository.create({ name: 'Bob', order: 3 });

    const nextOrder = await repository.getNextOrder();
    expect(nextOrder).toBe(4);
  });
});
