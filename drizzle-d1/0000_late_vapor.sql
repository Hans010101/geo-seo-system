CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alertType` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`relatedCollectionId` integer,
	`relatedQuestionId` text,
	`relatedPlatform` text,
	`isRead` integer DEFAULT false,
	`status` text DEFAULT 'active' NOT NULL,
	`dedupKey` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collectionId` integer NOT NULL,
	`sentimentScore` integer,
	`sentimentReasoning` text,
	`overallTone` text,
	`keyFacts` text,
	`positivePoints` text,
	`negativePoints` text,
	`targetFactsCheck` text,
	`factualAccuracy` text,
	`inaccurateClaims` text,
	`analysisModel` text,
	`analyzedAt` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `citations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collectionId` integer NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`domain` text,
	`position` integer DEFAULT 0,
	`sourceType` text DEFAULT 'unknown' NOT NULL,
	`isOurContent` integer DEFAULT false,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`questionId` text NOT NULL,
	`questionText` text NOT NULL,
	`platform` text NOT NULL,
	`language` text NOT NULL,
	`timestamp` integer NOT NULL,
	`responseText` text,
	`responseLength` integer DEFAULT 0,
	`hasSearch` integer DEFAULT false,
	`modelVersion` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`errorMessage` text,
	`rawResponse` text,
	`batchId` text,
	`provider` text,
	`realModel` text,
	`promptTokens` integer,
	`completionTokens` integer,
	`totalTokens` integer,
	`latencyMs` integer,
	`costUsd` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `globalApiKeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`apiKey` text,
	`baseUrl` text,
	`coveredPlatforms` text,
	`isActive` integer DEFAULT true,
	`sortOrder` integer DEFAULT 0,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitor_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`urlHash` text NOT NULL,
	`domain` text,
	`title` text,
	`contentMd` text,
	`contentHash` text,
	`publishedAt` integer,
	`firstSeenAt` integer,
	`fetchMethod` text,
	`fetchStatus` text,
	`fetchEngine` text,
	`sourcePlatform` text,
	`matchedKeywords` text,
	`sentimentScore` integer,
	`relevance` text,
	`relevanceReason` text,
	`threatLevel` text,
	`analysisSummary` text,
	`analyzedAt` integer,
	`promptTokens` integer,
	`completionTokens` integer,
	`costUsd` text,
	`fetchCostUsd` text DEFAULT '0',
	`archived` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_articles_url_unique` ON `monitor_articles` (`url`);--> statement-breakpoint
CREATE INDEX `monitor_articles_urlHash_idx` ON `monitor_articles` (`urlHash`);--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_articles_contentHash_uq` ON `monitor_articles` (`contentHash`);--> statement-breakpoint
CREATE INDEX `monitor_articles_domain_idx` ON `monitor_articles` (`domain`);--> statement-breakpoint
CREATE INDEX `monitor_articles_firstSeenAt_idx` ON `monitor_articles` (`firstSeenAt`);--> statement-breakpoint
CREATE TABLE `monitor_keywords` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyword` text NOT NULL,
	`keywordGroup` text,
	`searchFreq` text DEFAULT 'daily' NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitor_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reportType` text NOT NULL,
	`reportPeriod` text NOT NULL,
	`periodStart` integer NOT NULL,
	`periodEnd` integer NOT NULL,
	`reportData` text,
	`generatedAt` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_reports_type_period_uq` ON `monitor_reports` (`reportType`,`reportPeriod`);--> statement-breakpoint
CREATE TABLE `monitor_source_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`authorityLevel` integer DEFAULT 5 NOT NULL,
	`stance` text DEFAULT 'neutral' NOT NULL,
	`notes` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_source_rules_domain_unique` ON `monitor_source_rules` (`domain`);--> statement-breakpoint
CREATE TABLE `notificationConfigs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`isEnabled` integer DEFAULT false NOT NULL,
	`webhookUrl` text,
	`botToken` text,
	`chatId` text,
	`smtpHost` text,
	`smtpPort` integer,
	`smtpUser` text,
	`smtpPass` text,
	`emailFrom` text,
	`emailTo` text,
	`minSeverity` text DEFAULT 'high' NOT NULL,
	`silentStart` text DEFAULT '23:00',
	`silentEnd` text DEFAULT '08:00',
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notificationLogs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`alertId` integer,
	`batchId` text,
	`messageType` text DEFAULT 'alert' NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`success` integer NOT NULL,
	`errorMessage` text,
	`dedupKey` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ourContentUrls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`publishPlatform` text,
	`publishDate` integer,
	`contentType` text DEFAULT 'seo_article',
	`isActive` integer DEFAULT true,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platformConfigs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`displayName` text NOT NULL,
	`isEnabled` integer DEFAULT true,
	`apiKeyEncrypted` text,
	`apiBaseUrl` text,
	`modelVersion` text,
	`collectFrequency` text DEFAULT 'weekly',
	`extraConfig` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platformConfigs_platform_unique` ON `platformConfigs` (`platform`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`questionId` text NOT NULL,
	`text` text NOT NULL,
	`brandLine` text NOT NULL,
	`dimension` text NOT NULL,
	`coverageDimension` text,
	`language` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`validFrom` integer,
	`validUntil` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_questionId_unique` ON `questions` (`questionId`);--> statement-breakpoint
CREATE TABLE `schedulerConfigs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`cronExpression` text DEFAULT '0 8 * * *' NOT NULL,
	`concurrency` integer DEFAULT 5 NOT NULL,
	`lastRunAt` integer,
	`monitorEnabled` integer DEFAULT false NOT NULL,
	`monitorCron` text DEFAULT '0 9,21 * * *' NOT NULL,
	`monitorLastRunAt` integer,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sysConfigs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`configKey` text NOT NULL,
	`configValue` text,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sysConfigs_configKey_unique` ON `sysConfigs` (`configKey`);--> statement-breakpoint
CREATE TABLE `targetFacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`factKey` text NOT NULL,
	`factDescription` text NOT NULL,
	`validFrom` integer,
	`isActive` integer DEFAULT true,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `targetFacts_factKey_unique` ON `targetFacts` (`factKey`);--> statement-breakpoint
CREATE TABLE `telegram_bindings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`chatId` text,
	`chatTitle` text,
	`chatType` text,
	`expiresAt` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`boundAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_bindings_code_unique` ON `telegram_bindings` (`code`);--> statement-breakpoint
CREATE TABLE `urlMatchRules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`sourceType` text NOT NULL,
	`description` text,
	`isActive` integer DEFAULT true,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`openId` text NOT NULL,
	`name` text,
	`email` text,
	`passwordHash` text,
	`loginMethod` text,
	`role` text DEFAULT 'user' NOT NULL,
	`isBanned` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`lastSignedIn` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_openId_unique` ON `users` (`openId`);--> statement-breakpoint
CREATE TABLE `weeklyReports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reportWeek` text NOT NULL,
	`reportPeriod` text,
	`summaryMetrics` text,
	`platformBreakdown` text,
	`questionDetails` text,
	`citationAnalysis` text,
	`alertsSummary` text,
	`generatedAt` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weeklyReports_reportWeek_unique` ON `weeklyReports` (`reportWeek`);