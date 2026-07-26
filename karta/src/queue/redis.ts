import { Redis } from "ioredis";
import { config } from "../config.js";

/** Connexion Redis partagée (BullMQ exige maxRetriesPerRequest: null sur ses propres connexions). */
export const redisConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
