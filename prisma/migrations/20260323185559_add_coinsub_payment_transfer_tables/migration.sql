-- CreateTable
CREATE TABLE "CoinsubPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT,
    "merchantId" TEXT,
    "purchaseSessionId" TEXT,
    "paymentId" TEXT,
    "name" TEXT,
    "currency" TEXT,
    "amount" REAL,
    "status" TEXT,
    "metadata" JSONB,
    "rawPayload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CoinsubTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "merchantId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "transferId" TEXT,
    "toAddress" TEXT,
    "token" TEXT,
    "chainId" INTEGER,
    "amount" REAL,
    "status" TEXT,
    "transactionHash" TEXT,
    "rawPayload" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CoinsubPayment_purchaseSessionId_key" ON "CoinsubPayment"("purchaseSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinsubPayment_paymentId_key" ON "CoinsubPayment"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinsubTransfer_transferId_key" ON "CoinsubTransfer"("transferId");
