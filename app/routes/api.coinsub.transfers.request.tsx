import type { ActionFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type TransferRequestBody = {
  toAddress?: string;
  amount?: number;
  chainId?: number;
  token?: string;
  orderId?: string;
  paymentId?: string;
  dryRun?: boolean;
};

type CoinsubTransferResponse = {
  data?: {
    message?: string;
    status?: string;
    fee?: number;
    transfer_id?: string;
  };
  status?: number;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const db = prisma as any;
  const config = await prisma.coinsubConfig.findUnique({
    where: { shop: session.shop },
  });

  if (!config?.merchantId || !config?.apiKey) {
    return Response.json(
      { error: "Missing CoinSub merchant credentials for this shop" },
      { status: 400 },
    );
  }

  const body = (await request.json()) as TransferRequestBody;
  let orderId = body.orderId?.trim() || null;
  let paymentId = body.paymentId?.trim() || null;
  const toAddress = body.toAddress?.trim();
  const token = body.token?.trim();
  const amount = typeof body.amount === "number" ? body.amount : NaN;
  const chainId = typeof body.chainId === "number" ? body.chainId : NaN;

  if (!toAddress || !token || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(chainId)) {
    return Response.json(
      { error: "toAddress, token, amount>0, and integer chainId are required" },
      { status: 400 },
    );
  }

  if (paymentId && !orderId) {
    const paymentRecord = await db.coinsubPayment.findUnique({
      where: { paymentId },
      select: { orderId: true },
    });
    orderId = paymentRecord?.orderId || null;
  }

  if (orderId && !paymentId) {
    const paymentRecord = await db.coinsubPayment.findFirst({
      where: { shop: session.shop, orderId, paymentId: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { paymentId: true },
    });
    paymentId = paymentRecord?.paymentId || null;
  }

  const transferPayload = {
    to_address: toAddress,
    amount,
    chainId,
    token,
    metadata: {
      shop: session.shop,
      orderId,
      paymentId,
    },
  };

  if (body.dryRun) {
    await db.coinsubTransfer.create({
      data: {
        shop: session.shop,
        orderId,
        paymentId,
        merchantId: config.merchantId,
        toAddress,
        token,
        chainId,
        amount,
        status: "dry_run",
        rawPayload: JSON.parse(JSON.stringify(transferPayload)) as Prisma.InputJsonValue,
      },
    });

    return Response.json({
      shop: session.shop,
      transferPayload,
      notes: ["dryRun=true: CoinSub transfer request skipped."],
    });
  }

  const transferUrl =
    process.env.COINSUB_TRANSFER_REQUEST_URL ||
    "https://api.coinsub.io/v1/merchants/transfer/request";

  const transferResponse = await fetch(transferUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Merchant-ID": config.merchantId,
      "API-Key": config.apiKey,
    },
    body: JSON.stringify(transferPayload),
  });

  const transferResult =
    (await transferResponse.json().catch(() => null)) as
      | CoinsubTransferResponse
      | null;

  await db.coinsubTransfer.create({
    data: {
      shop: session.shop,
      orderId,
      paymentId,
      merchantId: config.merchantId,
      transferId: transferResult?.data?.transfer_id || null,
      toAddress,
      token,
      chainId,
      amount,
      status: transferResult?.data?.status || (transferResponse.ok ? "submitted" : "failed"),
      rawPayload: transferResult
        ? (JSON.parse(JSON.stringify(transferResult)) as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });

  return Response.json({
    shop: session.shop,
    transferPayload,
    coinsub: {
      status: transferResponse.status,
      ok: transferResponse.ok,
      result: transferResult,
    },
  });
};
