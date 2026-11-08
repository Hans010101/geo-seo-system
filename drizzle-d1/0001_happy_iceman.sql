ALTER TABLE `alerts` ADD `resolvedAt` integer;--> statement-breakpoint
ALTER TABLE `alerts` ADD `resolvedBy` text;--> statement-breakpoint
ALTER TABLE `alerts` ADD `resolutionNote` text;--> statement-breakpoint
CREATE INDEX `alerts_status_createdAt_idx` ON `alerts` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `alerts_dedup_status_createdAt_idx` ON `alerts` (`dedupKey`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `analyses_collection_idx` ON `analyses` (`collectionId`);--> statement-breakpoint
CREATE INDEX `citations_collection_idx` ON `citations` (`collectionId`);--> statement-breakpoint
CREATE INDEX `collections_status_timestamp_idx` ON `collections` (`status`,`timestamp`);--> statement-breakpoint
CREATE INDEX `collections_batch_status_idx` ON `collections` (`batchId`,`status`);--> statement-breakpoint
CREATE INDEX `collections_question_platform_timestamp_idx` ON `collections` (`questionId`,`platform`,`timestamp`);--> statement-breakpoint
CREATE INDEX `monitor_articles_published_relevance_idx` ON `monitor_articles` (`publishedAt`,`relevance`);--> statement-breakpoint
CREATE INDEX `monitor_articles_source_published_idx` ON `monitor_articles` (`sourcePlatform`,`publishedAt`);--> statement-breakpoint
PRAGMA optimize;
