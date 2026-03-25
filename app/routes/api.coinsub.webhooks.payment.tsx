import type { ActionFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

type CoinsubWebhookPayload = {
  type?: "payment" | "failed_payment" | "transfer" | string;
  merchant_id?: string;
  origin_id?: string;
  payment_id?: string;
  name?: string;
  currency?: string;
  amount?: number;
  status?: string;
  transfer_id?: string;
  to_address?: string;
  hash?: string;
  network?: string;
  amount_in_usd?: string;
  metadata?: {
    shop?: string;
    orderId?: string;
    items?: { variantId?: string; quantity?: number; itemName?: string }[];
    paymentId?: string;
    [key: string]: unknown;
  } | null;
};

async function addOrderTag(shop: string, orderId: string, tag: string) {
  const { admin } = await unauthenticated.admin(shop);
  await admin.graphql(
    `#graphql
      mutation CoinsubAddOrderTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: orderId,
        tags: [tag],
      },
    },
  );
}

async function removeOrderTags(shop: string, orderId: string, tags: string[]) {
  const { admin } = await unauthenticated.admin(shop);
  await admin.graphql(
    `#graphql
      mutation CoinsubRemoveOrderTags($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: orderId,
        tags,
      },
    },
  );
}

async function markOrderAsPaid(shop: string, orderId: string) {
  const { admin } = await unauthenticated.admin(shop);
  await admin.graphql(
    `#graphql
      mutation CoinsubMarkOrderAsPaid($input: MarkOrderAsPaidInput!) {
        markOrderAsPaid(input: $input) {
          order {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          id: orderId,
        },
      },
    },
  );
}

async function closeOrderAsFailed(shop: string, orderId: string) {
  const { admin } = await unauthenticated.admin(shop);
  await admin.graphql(
    `#graphql
      mutation CoinsubCloseOrderAsFailed($id: ID!) {
        orderClose(id: $id) {
          order {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { id: orderId } },
  );
}

async function createOrderFromSnapshot(
  shop: string,
  items: { variantId?: string; quantity?: number }[],
) {
  const { admin } = await unauthenticated.admin(shop);
  const validItems = items.filter(
    (item) => item.variantId && Number.isInteger(item.quantity) && Number(item.quantity) > 0,
  );
  if (validItems.length === 0) return null;

  const draftCreateResponse = await admin.graphql(
    `#graphql
      mutation CoinsubDraftOrderCreateFromWebhook($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          lineItems: validItems.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          tags: ["coinsub_pending", "coinsub_created_from_webhook"],
          note: "Created from CoinSub payment webhook snapshot",
        },
      },
    },
  );

  const draftCreateJson = (await draftCreateResponse.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string } | null;
      };
    };
  };
  const draftId = draftCreateJson.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) return null;

  const completeResponse = await admin.graphql(
    `#graphql
      mutation CoinsubDraftOrderCompleteFromWebhook($id: ID!) {
        draftOrderComplete(id: $id, paymentPending: true) {
          draftOrder {
            order {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { variables: { id: draftId } },
  );

  const completeJson = (await completeResponse.json()) as {
    data?: {
      draftOrderComplete?: {
        draftOrder?: { order?: { id: string; name: string } | null } | null;
      };
    };
  };

  return completeJson.data?.draftOrderComplete?.draftOrder?.order ?? null;
}

function verifyCoinsubSignature(rawBody: string, providedSignature: string, secret: string) {
  const normalizedProvided = providedSignature.replace(/^sha256=/i, "").trim();
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  const providedBuffer = Buffer.from(normalizedProvided, "hex");
  const computedBuffer = Buffer.from(computed, "hex");

  if (providedBuffer.length !== computedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, computedBuffer);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.text();
  let payload: CoinsubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CoinsubWebhookPayload;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON payload" }, { status: 400 });
  }

  const db = prisma as any;
  const metadata = payload.metadata || {};
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const signatureSecret = process.env.COINSUB_WEBHOOK_SECRET;
  const signatureHeader =
    request.headers.get("x-coinsub-signature") ||
    request.headers.get("x-signature") ||
    request.headers.get("x-webhook-signature");
  const eventId = request.headers.get("x-event-id");

  // Signature verification is optional for MVP. If both secret and header are present,
  // validate it; otherwise rely on webhook token + event dedupe protections.
  if (signatureSecret && signatureHeader) {
    if (!verifyCoinsubSignature(rawBody, signatureHeader, signatureSecret)) {
      return Response.json({ ok: false, error: "Invalid webhook signature" }, { status: 401 });
    }
  }

  if (!eventId) {
    return Response.json({ ok: false, error: "Missing X-Event-Id header" }, { status: 400 });
  }

  let shop = metadata.shop;

  if (!shop && payload.merchant_id) {
    const config = await prisma.coinsubConfig.findFirst({
      where: { merchantId: payload.merchant_id },
      select: { shop: true },
    });
    shop = config?.shop;
  }

  if (!shop) {
    return Response.json(
      { ok: false, error: "Unable to resolve shop from webhook payload" },
      { status: 400 },
    );
  }

  const shopConfig = await prisma.coinsubConfig.findUnique({
    where: { shop },
    select: { webhookToken: true },
  });

  if (!shopConfig || !token || token !== shopConfig.webhookToken) {
    return Response.json({ ok: false, error: "Invalid webhook token" }, { status: 401 });
  }

  try {
    await db.coinsubWebhookEvent.create({
      data: {
        shop,
        eventId,
        eventType: payload.type || null,
        status: payload.status || null,
        rawPayload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
      },
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return Response.json({ ok: true, deduped: true, eventId, shop });
    }
    throw error;
  }

  let orderId = metadata.orderId;
  if (payload.type === "payment" || payload.type === "failed_payment") {
    if (!orderId && payload.type === "payment" && payload.status === "completed" && Array.isArray(metadata.items)) {
      const createdOrder = await createOrderFromSnapshot(shop, metadata.items);
      orderId = createdOrder?.id;
    }

    const existingPayment = payload.payment_id
      ? await db.coinsubPayment.findUnique({
          where: { paymentId: payload.payment_id },
          select: { status: true, orderId: true },
        })
      : null;

    if (payload.payment_id) {
      await db.coinsubPayment.upsert({
        where: { paymentId: payload.payment_id },
        update: {
          shop,
          orderId: orderId || null,
          merchantId: payload.merchant_id || null,
          purchaseSessionId: payload.origin_id || null,
          name: payload.name || null,
          currency: payload.currency || null,
          amount: payload.amount ?? null,
          status: payload.status || null,
          metadata: payload.metadata
            ? (JSON.parse(JSON.stringify(payload.metadata)) as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          rawPayload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
        },
        create: {
          shop,
          orderId: orderId || null,
          merchantId: payload.merchant_id || null,
          paymentId: payload.payment_id,
          purchaseSessionId: payload.origin_id || null,
          name: payload.name || null,
          currency: payload.currency || null,
          amount: payload.amount ?? null,
          status: payload.status || null,
          metadata: payload.metadata
            ? (JSON.parse(JSON.stringify(payload.metadata)) as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          rawPayload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
        },
      });
    }

    const shouldApplyOrderTransition =
      Boolean(orderId) &&
      (existingPayment?.status !== (payload.status || null) ||
        existingPayment?.orderId !== (orderId || null));

    if (orderId && shouldApplyOrderTransition) {
      if (payload.type === "payment" && payload.status === "completed") {
        await removeOrderTags(shop, orderId, ["coinsub_pending", "coinsub_failed"]);
        await addOrderTag(shop, orderId, "coinsub_paid");
        await markOrderAsPaid(shop, orderId).catch(() => null);
      } else if (payload.type === "failed_payment" || payload.status === "failed") {
        await removeOrderTags(shop, orderId, ["coinsub_pending", "coinsub_paid"]);
        await addOrderTag(shop, orderId, "coinsub_failed");
        await closeOrderAsFailed(shop, orderId).catch(() => null);
      }
    }
  }

  if (payload.type === "transfer" && payload.transfer_id) {
    const metadataPaymentId =
      typeof metadata.paymentId === "string" ? metadata.paymentId : null;
    let resolvedPaymentId = metadataPaymentId;
    let resolvedOrderId = orderId || null;

    if (resolvedPaymentId && !resolvedOrderId) {
      const paymentRecord = await db.coinsubPayment.findUnique({
        where: { paymentId: resolvedPaymentId },
        select: { orderId: true },
      });
      resolvedOrderId = paymentRecord?.orderId || null;
    }

    if (!resolvedPaymentId && resolvedOrderId) {
      const paymentRecord = await db.coinsubPayment.findFirst({
        where: { shop, orderId: resolvedOrderId, paymentId: { not: null } },
        orderBy: { updatedAt: "desc" },
        select: { paymentId: true },
      });
      resolvedPaymentId = paymentRecord?.paymentId || null;
    }

    await db.coinsubTransfer.upsert({
      where: { transferId: payload.transfer_id },
      update: {
        shop,
        orderId: resolvedOrderId,
        paymentId: resolvedPaymentId,
        merchantId: payload.merchant_id || null,
        toAddress: payload.to_address || null,
        amount: payload.amount_in_usd ? Number.parseFloat(payload.amount_in_usd) : null,
        status: payload.status || null,
        transactionHash: payload.hash || null,
        rawPayload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
      },
      create: {
        shop,
        orderId: resolvedOrderId,
        paymentId: resolvedPaymentId,
        merchantId: payload.merchant_id || null,
        transferId: payload.transfer_id,
        toAddress: payload.to_address || null,
        amount: payload.amount_in_usd ? Number.parseFloat(payload.amount_in_usd) : null,
        status: payload.status || null,
        transactionHash: payload.hash || null,
        rawPayload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
      },
    });
  }

  await db.coinsubWebhookEvent.update({
    where: { eventId },
    data: { processedAt: new Date() },
  });

  return Response.json({
    ok: true,
    shop,
    eventId,
    eventType: payload.type || null,
    paymentId: payload.payment_id || null,
    orderId: orderId || null,
  });
};
