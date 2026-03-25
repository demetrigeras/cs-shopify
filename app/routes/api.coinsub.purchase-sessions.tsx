import type { ActionFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type PurchaseLineInput = {
  variantId: string;
  quantity: number;
};

type OrderLineNode = {
  quantity: number;
  title: string;
  variant: {
    id: string;
  } | null;
};

type OrderSnapshot = {
  id: string;
  name: string;
  currentTotalPriceSet: {
    shopMoney: {
      amount: string;
      currencyCode: string;
    };
  };
  lineItems: {
    nodes: OrderLineNode[];
  };
};

type VariantNode = {
  id: string;
  title: string;
  price: string;
  product: {
    title: string;
  };
};

type CanonicalLine = {
  variantId: string;
  itemName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

type CoinsubCreateSessionResult = {
  data?: {
    url?: string;
    purchase_session_id?: string;
    status?: string;
  };
  status?: number;
};

type ShopifyAdmin = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

function toCents(price: string): number {
  const parsed = Number.parseFloat(price);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function buildItemName(variant: VariantNode): string {
  if (!variant.title || variant.title === "Default Title") {
    return variant.product.title;
  }
  return `${variant.product.title} - ${variant.title}`;
}

async function fetchOrderSnapshot(admin: ShopifyAdmin, orderId: string) {
  const orderResponse = await admin.graphql(
    `#graphql
      query CoinsubOrder($id: ID!) {
        order(id: $id) {
          id
          name
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            nodes {
              quantity
              title
              variant {
                id
              }
            }
          }
        }
      }
    `,
    { variables: { id: orderId } },
  );

  const orderJson = (await orderResponse.json()) as {
    data?: { order?: OrderSnapshot | null };
  };
  return orderJson.data?.order ?? null;
}

async function createPendingOrderFromLines(admin: ShopifyAdmin, lines: CanonicalLine[]) {
  const draftCreateResponse = await admin.graphql(
    `#graphql
      mutation CoinsubDraftOrderCreate($input: DraftOrderInput!) {
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
          lineItems: lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
          tags: ["coinsub_pending"],
          note: "Pending CoinSub payment",
        },
      },
    },
  );

  const draftCreateJson = (await draftCreateResponse.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id: string } | null;
        userErrors?: { message: string }[];
      };
    };
  };

  const draftId = draftCreateJson.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) {
    const message =
      draftCreateJson.data?.draftOrderCreate?.userErrors?.[0]?.message ||
      "Failed to create draft order";
    throw new Error(message);
  }

  const completeResponse = await admin.graphql(
    `#graphql
      mutation CoinsubDraftOrderComplete($id: ID!) {
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
        userErrors?: { message: string }[];
      };
    };
  };

  const order = completeJson.data?.draftOrderComplete?.draftOrder?.order;
  if (!order?.id) {
    const message =
      completeJson.data?.draftOrderComplete?.userErrors?.[0]?.message ||
      "Failed to complete pending order";
    throw new Error(message);
  }

  return order;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { admin, session } = await authenticate.admin(request);
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

  const body = (await request.json()) as {
    lines?: PurchaseLineInput[];
    orderId?: string;
    details?: string;
    successUrl?: string;
    cancelUrl?: string;
    expiresInHours?: number;
    dryRun?: boolean;
  };

  const inputOrderId = body.orderId?.trim();
  const lines = body.lines ?? [];

  if (!inputOrderId && lines.length === 0) {
    return Response.json(
      { error: "Either orderId or at least one purchase line is required" },
      { status: 400 },
    );
  }

  let totalCents = 0;
  let currency = "USD";
  let displayName = "CoinSub purchase";
  let orderSummary: { orderId: string; orderName: string } | null = null;
  const canonicalLines: CanonicalLine[] = [];

  if (inputOrderId) {
    const order = await fetchOrderSnapshot(admin as ShopifyAdmin, inputOrderId);
    if (!order) {
      return Response.json(
        { error: `Order not found: ${inputOrderId}` },
        { status: 400 },
      );
    }

    totalCents = toCents(order.currentTotalPriceSet.shopMoney.amount);
    currency = order.currentTotalPriceSet.shopMoney.currencyCode;
    displayName = order.name;
    orderSummary = { orderId: order.id, orderName: order.name };

    for (const line of order.lineItems.nodes) {
      if (line.variant?.id) {
        canonicalLines.push({
          variantId: line.variant.id,
          itemName: line.title,
          quantity: line.quantity,
          unitPriceCents: 0,
          lineTotalCents: 0,
        });
      }
    }
  } else {
    const invalidLine = lines.find(
      (line) => !line.variantId || !Number.isInteger(line.quantity) || line.quantity <= 0,
    );
    if (invalidLine) {
      return Response.json(
        { error: "Each line must include variantId and quantity > 0" },
        { status: 400 },
      );
    }

    const uniqueVariantIds = Array.from(new Set(lines.map((line) => line.variantId)));
    const variantsResponse = await admin.graphql(
      `#graphql
        query CoinsubVariantPricing($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              price
              product {
                title
              }
            }
          }
        }
      `,
      { variables: { ids: uniqueVariantIds } },
    );

    const variantsJson = (await variantsResponse.json()) as {
      data?: { nodes?: (VariantNode | null)[] };
    };

    const variantMap = new Map<string, VariantNode>();
    for (const node of variantsJson.data?.nodes ?? []) {
      if (node?.id) variantMap.set(node.id, node);
    }

    for (const line of lines) {
      const variant = variantMap.get(line.variantId);
      if (!variant) {
        return Response.json(
          { error: `Variant not found: ${line.variantId}` },
          { status: 400 },
        );
      }

      const itemName = buildItemName(variant);

      canonicalLines.push({
        variantId: variant.id,
        itemName,
        quantity: line.quantity,
        unitPriceCents: 0,
        lineTotalCents: 0,
      });
    }

    const createdOrder = await createPendingOrderFromLines(admin as ShopifyAdmin, canonicalLines);
    const createdOrderSnapshot = await fetchOrderSnapshot(admin as ShopifyAdmin, createdOrder.id);
    if (!createdOrderSnapshot) {
      return Response.json(
        { error: `Created order not found: ${createdOrder.id}` },
        { status: 400 },
      );
    }

    totalCents = toCents(createdOrderSnapshot.currentTotalPriceSet.shopMoney.amount);
    currency = createdOrderSnapshot.currentTotalPriceSet.shopMoney.currencyCode;
    displayName = createdOrderSnapshot.name;
    orderSummary = {
      orderId: createdOrderSnapshot.id,
      orderName: createdOrderSnapshot.name,
    };
  }

  if (totalCents <= 0) {
    return Response.json(
      { error: "Computed order total must be greater than zero" },
      { status: 400 },
    );
  }

  const amount = (totalCents / 100).toFixed(2);
  const details = body.details?.trim() || `Shopify shop ${session.shop}`;
  const coinsubPayload = {
    name: displayName,
    details,
    amount: Number(amount),
    currency,
    recurring: false,
    success_url: body.successUrl,
    cancel_url: body.cancelUrl,
    expires_in_hours: body.expiresInHours,
    metadata: {
      shop: session.shop,
      orderId: orderSummary?.orderId || null,
      items: canonicalLines.map((line) => ({
        variantId: line.variantId,
        itemName: line.itemName,
        quantity: line.quantity,
      })),
    },
  };

  if (body.dryRun) {
    await db.coinsubPayment.create({
      data: {
        shop: session.shop,
        orderId: orderSummary?.orderId || null,
        merchantId: config.merchantId,
        name: displayName,
        currency,
        amount: Number(amount),
        status: "dry_run",
        metadata: JSON.parse(JSON.stringify(coinsubPayload.metadata)) as Prisma.InputJsonValue,
        rawPayload: JSON.parse(JSON.stringify(coinsubPayload)) as Prisma.InputJsonValue,
      },
    });

    return Response.json({
      shop: session.shop,
      order: orderSummary,
      coinsubPayload,
      notes: ["dryRun=true: CoinSub API call skipped."],
    });
  }

  const createSessionUrl =
    process.env.COINSUB_CREATE_SESSION_URL ||
    "https://api.coinsub.io/v1/purchase/session/start";
  const coinsubResponse = await fetch(createSessionUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Merchant-ID": config.merchantId,
      "API-Key": config.apiKey,
    },
    body: JSON.stringify(coinsubPayload),
  });

  const coinsubResult =
    (await coinsubResponse.json().catch(() => null)) as CoinsubCreateSessionResult | null;

  const purchaseSessionId = coinsubResult?.data?.purchase_session_id || null;
  if (purchaseSessionId) {
    await db.coinsubPayment.upsert({
      where: { purchaseSessionId },
      update: {
        shop: session.shop,
        orderId: orderSummary?.orderId || null,
        merchantId: config.merchantId,
        name: displayName,
        currency,
        amount: Number(amount),
        status: coinsubResult?.data?.status || (coinsubResponse.ok ? "session_created" : "session_error"),
        metadata: JSON.parse(JSON.stringify(coinsubPayload.metadata)) as Prisma.InputJsonValue,
        rawPayload: coinsubResult
          ? (JSON.parse(JSON.stringify(coinsubResult)) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
      create: {
        shop: session.shop,
        orderId: orderSummary?.orderId || null,
        merchantId: config.merchantId,
        purchaseSessionId,
        name: displayName,
        currency,
        amount: Number(amount),
        status: coinsubResult?.data?.status || (coinsubResponse.ok ? "session_created" : "session_error"),
        metadata: JSON.parse(JSON.stringify(coinsubPayload.metadata)) as Prisma.InputJsonValue,
        rawPayload: coinsubResult
          ? (JSON.parse(JSON.stringify(coinsubResult)) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  }

  return Response.json({
    shop: session.shop,
    order: orderSummary,
    coinsubPayload,
    coinsub: {
      status: coinsubResponse.status,
      ok: coinsubResponse.ok,
      checkoutUrl: coinsubResult?.data?.url || null,
      purchaseSessionId,
      result: coinsubResult,
    },
  });
};
