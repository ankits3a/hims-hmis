import { Module } from "@nestjs/common";
import { RealtimeGateway } from "./gateway";

@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
