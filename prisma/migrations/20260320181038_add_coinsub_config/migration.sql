-- CreateTable
CREATE TABLE "CoinsubConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "merchantId" TEXT,
    "apiKey" TEXT,
    "webhookToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CoinsubConfig_shop_key" ON "CoinsubConfig"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CoinsubConfig_webhookToken_key" ON "CoinsubConfig"("webhookToken");
