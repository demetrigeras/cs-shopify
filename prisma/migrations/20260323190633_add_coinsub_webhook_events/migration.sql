-- CreateTable
CREATE TABLE "CoinsubWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT,
    "status" TEXT,
    "processedAt" DATETIME,
    "rawPayload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "CoinsubWebhookEvent_eventId_key" ON "CoinsubWebhookEvent"("eventId");
