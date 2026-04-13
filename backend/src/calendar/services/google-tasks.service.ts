import { Injectable, Logger } from '@nestjs/common';
import { google, tasks_v1 } from 'googleapis';
import { OAuthService } from '../../auth/services/oauth.service';
import type {
  IGoogleTasksService,
  TaskListInfo,
} from '../interfaces/google-tasks-service.interface';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export class GoogleTasksScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTasksScopeError';
  }
}

@Injectable()
export class GoogleTasksService implements IGoogleTasksService {
  private readonly logger = new Logger(GoogleTasksService.name);
  private readonly childTaskListCache = new Map<string, string>();

  constructor(private readonly oauthService: OAuthService) {}

  private async getTasksClient(): Promise<tasks_v1.Tasks> {
    const accessToken = await this.oauthService.getValidAccessToken('calendar');
    const oauth2Client = this.oauthService.getOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    return google.tasks({ version: 'v1', auth: oauth2Client });
  }

  async createTask(
    title: string,
    notes: string | undefined,
    dueDate: string,
    taskListId: string,
  ): Promise<string> {
    const tasksClient = await this.getTasksClient();

    const response = await this.withRetry(async () => {
      return tasksClient.tasks.insert({
        tasklist: taskListId,
        requestBody: {
          title,
          notes: notes || undefined,
          due: `${dueDate}T00:00:00.000Z`,
        },
      });
    }, 'createTask');

    const taskId = response.data.id!;
    this.logger.log(`Created Google Task: ${taskId} for "${title}"`);
    return taskId;
  }

  async deleteTask(taskId: string, taskListId: string): Promise<boolean> {
    const tasksClient = await this.getTasksClient();

    await this.withRetry(async () => {
      return tasksClient.tasks.delete({
        tasklist: taskListId,
        task: taskId,
      });
    }, 'deleteTask');

    this.logger.log(`Deleted Google Task: ${taskId}`);
    return true;
  }

  async getTaskLists(): Promise<TaskListInfo[]> {
    const tasksClient = await this.getTasksClient();

    const response = await this.withRetry(async () => {
      return tasksClient.tasklists.list({ maxResults: 100 });
    }, 'getTaskLists');

    return (response.data.items || []).map((item) => ({
      id: item.id!,
      title: item.title || item.id!,
    }));
  }

  async createTaskList(title: string): Promise<string> {
    const tasksClient = await this.getTasksClient();

    const response = await this.withRetry(async () => {
      return tasksClient.tasklists.insert({
        requestBody: { title },
      });
    }, 'createTaskList');

    const listId = response.data.id!;
    this.logger.log(`Created Google Task List: ${listId} ("${title}")`);
    return listId;
  }

  async findOrCreateChildTaskList(childName: string): Promise<string> {
    // Check cache first
    const cached = this.childTaskListCache.get(childName);
    if (cached) {
      return cached;
    }

    // Search existing task lists
    const lists = await this.getTaskLists();
    const existing = lists.find((l) => l.title === childName);
    if (existing) {
      this.childTaskListCache.set(childName, existing.id);
      return existing.id;
    }

    // Create new task list for this child
    const newId = await this.createTaskList(childName);
    this.childTaskListCache.set(childName, newId);
    return newId;
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const code =
          (error as { code?: number }).code ??
          (error as { response?: { status?: number } }).response?.status;

        // 403 means Tasks scope not granted — throw typed error for fallback
        if (code === 403) {
          throw new GoogleTasksScopeError(
            `Google Tasks API returned 403 — Tasks scope may not be granted. ${(error as Error).message}`,
          );
        }

        lastError = error as Error;
        this.logger.warn(
          `${label} attempt ${attempt}/${MAX_RETRIES} failed: ${(error as Error).message}`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * attempt),
          );
        }
      }
    }

    throw lastError;
  }
}
