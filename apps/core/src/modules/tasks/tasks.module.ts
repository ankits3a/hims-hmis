import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller";

/** Controllers only — AuthGuard/PermissionGuard are the global APP_GUARDs. The clock (`sweepTasks`) is the WORKER's job. */
@Module({ controllers: [TasksController] })
export class TasksModule {}
