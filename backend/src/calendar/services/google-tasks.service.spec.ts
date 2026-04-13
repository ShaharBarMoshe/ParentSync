import { Test, TestingModule } from '@nestjs/testing';
import { GoogleTasksService, GoogleTasksScopeError } from './google-tasks.service';
import { OAuthService } from '../../auth/services/oauth.service';

// Mock googleapis
jest.mock('googleapis', () => {
  const mockTasksInsert = jest.fn();
  const mockTasksDelete = jest.fn();
  const mockTasklistsList = jest.fn();
  const mockTasklistsInsert = jest.fn();
  return {
    google: {
      tasks: jest.fn(() => ({
        tasks: {
          insert: mockTasksInsert,
          delete: mockTasksDelete,
        },
        tasklists: {
          list: mockTasklistsList,
          insert: mockTasklistsInsert,
        },
      })),
    },
    __mockTasksInsert: mockTasksInsert,
    __mockTasksDelete: mockTasksDelete,
    __mockTasklistsList: mockTasklistsList,
    __mockTasklistsInsert: mockTasklistsInsert,
  };
});

const {
  __mockTasksInsert,
  __mockTasksDelete,
  __mockTasklistsList,
  __mockTasklistsInsert,
} = jest.requireMock('googleapis');

describe('GoogleTasksService', () => {
  let service: GoogleTasksService;
  let oauthService: jest.Mocked<OAuthService>;

  beforeEach(async () => {
    const mockOAuthService = {
      getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
      getOAuth2Client: jest.fn().mockReturnValue({
        setCredentials: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleTasksService,
        { provide: OAuthService, useValue: mockOAuthService },
      ],
    }).compile();

    service = module.get<GoogleTasksService>(GoogleTasksService);
    oauthService = module.get(OAuthService);

    jest.clearAllMocks();
    oauthService.getValidAccessToken.mockResolvedValue('mock-access-token');
    oauthService.getOAuth2Client.mockReturnValue({
      setCredentials: jest.fn(),
    } as any);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createTask', () => {
    it('should create a task and return its ID', async () => {
      __mockTasksInsert.mockResolvedValue({ data: { id: 'task-123' } });

      const result = await service.createTask(
        'Test Task',
        'Some notes',
        '2026-04-15',
        'list-1',
      );

      expect(result).toBe('task-123');
      expect(__mockTasksInsert).toHaveBeenCalledWith({
        tasklist: 'list-1',
        requestBody: {
          title: 'Test Task',
          notes: 'Some notes',
          due: '2026-04-15T00:00:00.000Z',
        },
      });
    });

    it('should create a task without notes', async () => {
      __mockTasksInsert.mockResolvedValue({ data: { id: 'task-456' } });

      const result = await service.createTask(
        'No Notes Task',
        undefined,
        '2026-04-15',
        'list-1',
      );

      expect(result).toBe('task-456');
      expect(__mockTasksInsert).toHaveBeenCalledWith({
        tasklist: 'list-1',
        requestBody: {
          title: 'No Notes Task',
          notes: undefined,
          due: '2026-04-15T00:00:00.000Z',
        },
      });
    });

    it('should throw GoogleTasksScopeError on 403', async () => {
      const error = new Error('Forbidden') as any;
      error.code = 403;
      __mockTasksInsert.mockRejectedValue(error);

      await expect(
        service.createTask('Test', undefined, '2026-04-15', 'list-1'),
      ).rejects.toThrow(GoogleTasksScopeError);
    });

    it('should retry on transient errors', async () => {
      __mockTasksInsert
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ data: { id: 'task-retry' } });

      const result = await service.createTask(
        'Retry Task',
        undefined,
        '2026-04-15',
        'list-1',
      );

      expect(result).toBe('task-retry');
      expect(__mockTasksInsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteTask', () => {
    it('should delete a task and return true', async () => {
      __mockTasksDelete.mockResolvedValue({});

      const result = await service.deleteTask('task-123', 'list-1');

      expect(result).toBe(true);
      expect(__mockTasksDelete).toHaveBeenCalledWith({
        tasklist: 'list-1',
        task: 'task-123',
      });
    });
  });

  describe('getTaskLists', () => {
    it('should return task lists', async () => {
      __mockTasklistsList.mockResolvedValue({
        data: {
          items: [
            { id: 'list-1', title: 'Alice' },
            { id: 'list-2', title: 'Bob' },
          ],
        },
      });

      const result = await service.getTaskLists();

      expect(result).toEqual([
        { id: 'list-1', title: 'Alice' },
        { id: 'list-2', title: 'Bob' },
      ]);
    });

    it('should return empty array when no task lists', async () => {
      __mockTasklistsList.mockResolvedValue({ data: { items: null } });

      const result = await service.getTaskLists();

      expect(result).toEqual([]);
    });
  });

  describe('createTaskList', () => {
    it('should create a task list and return its ID', async () => {
      __mockTasklistsInsert.mockResolvedValue({ data: { id: 'new-list' } });

      const result = await service.createTaskList('Alice');

      expect(result).toBe('new-list');
      expect(__mockTasklistsInsert).toHaveBeenCalledWith({
        requestBody: { title: 'Alice' },
      });
    });
  });

  describe('findOrCreateChildTaskList', () => {
    it('should return existing list if found', async () => {
      __mockTasklistsList.mockResolvedValue({
        data: {
          items: [{ id: 'existing-list', title: 'Alice' }],
        },
      });

      const result = await service.findOrCreateChildTaskList('Alice');

      expect(result).toBe('existing-list');
      expect(__mockTasklistsInsert).not.toHaveBeenCalled();
    });

    it('should create new list if not found', async () => {
      __mockTasklistsList.mockResolvedValue({
        data: { items: [{ id: 'other', title: 'Bob' }] },
      });
      __mockTasklistsInsert.mockResolvedValue({
        data: { id: 'new-alice-list' },
      });

      const result = await service.findOrCreateChildTaskList('Alice');

      expect(result).toBe('new-alice-list');
      expect(__mockTasklistsInsert).toHaveBeenCalled();
    });

    it('should cache task list IDs', async () => {
      __mockTasklistsList.mockResolvedValue({
        data: {
          items: [{ id: 'cached-list', title: 'Alice' }],
        },
      });

      await service.findOrCreateChildTaskList('Alice');
      await service.findOrCreateChildTaskList('Alice');

      // Should only call API once due to caching
      expect(__mockTasklistsList).toHaveBeenCalledTimes(1);
    });
  });
});
