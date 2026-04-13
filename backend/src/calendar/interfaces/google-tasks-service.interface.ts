export interface TaskListInfo {
  id: string;
  title: string;
}

export interface IGoogleTasksService {
  createTask(
    title: string,
    notes: string | undefined,
    dueDate: string,
    taskListId: string,
  ): Promise<string>; // returns Google Task ID
  deleteTask(taskId: string, taskListId: string): Promise<boolean>;
  getTaskLists(): Promise<TaskListInfo[]>;
  createTaskList(title: string): Promise<string>; // returns list ID
  findOrCreateChildTaskList(childName: string): Promise<string>; // returns list ID
}
