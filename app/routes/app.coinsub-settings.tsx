import { randomBytes } from "node:crypto";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type ActionData = {
  ok?: boolean;
  errors?: {
    merchantId?: string;
    apiKey?: string;
  };
};

type RecentPayment = {
  paymentId: string | null;
  orderId: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  updatedAt: Date;
};

type RecentTransfer = {
  transferId: string | null;
  paymentId: string | null;
  orderId: string | null;
  status: string | null;
  amount: number | null;
  token: string | null;
  updatedAt: Date;
};

function createWebhookToken() {
  return randomBytes(24).toString("hex");
}

function buildWebhookUrl(appUrl: string, shop: string, token: string) {
  const normalizedAppUrl = appUrl.replace(/\/$/, "");
  return `${normalizedAppUrl}/api/coinsub/webhooks/payment?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(token)}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let config = await prisma.coinsubConfig.findUnique({
    where: { shop: session.shop },
  });

  if (!config) {
    config = await prisma.coinsubConfig.create({
      data: {
        shop: session.shop,
        webhookToken: createWebhookToken(),
      },
    });
  }

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const webhookUrl = appUrl
    ? buildWebhookUrl(appUrl, session.shop, config.webhookToken)
    : "";

  const [recentPayments, recentTransfers] = await Promise.all([
    (prisma as any).coinsubPayment.findMany({
      where: { shop: session.shop },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        paymentId: true,
        orderId: true,
        status: true,
        amount: true,
        currency: true,
        updatedAt: true,
      },
    }),
    (prisma as any).coinsubTransfer.findMany({
      where: { shop: session.shop },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        transferId: true,
        paymentId: true,
        orderId: true,
        status: true,
        amount: true,
        token: true,
        updatedAt: true,
      },
    }),
  ]) as [RecentPayment[], RecentTransfer[]];

  return {
    merchantId: config.merchantId || "",
    hasApiKey: Boolean(config.apiKey),
    webhookUrl,
    recentPayments,
    recentTransfers,
  };
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const merchantId = String(formData.get("merchantId") || "").trim();
  const apiKeyInput = String(formData.get("apiKey") || "").trim();

  const errors: ActionData["errors"] = {};

  if (!merchantId) {
    errors.merchantId = "Merchant ID is required.";
  }

  const existingConfig = await prisma.coinsubConfig.findUnique({
    where: { shop: session.shop },
  });

  const apiKeyToStore = apiKeyInput || existingConfig?.apiKey || null;
  if (!apiKeyToStore) {
    errors.apiKey = "API key is required on first save.";
  }

  if (errors.merchantId || errors.apiKey) {
    return { ok: false, errors };
  }

  await prisma.coinsubConfig.upsert({
    where: { shop: session.shop },
    update: {
      merchantId,
      apiKey: apiKeyToStore,
    },
    create: {
      shop: session.shop,
      merchantId,
      apiKey: apiKeyToStore,
      webhookToken: createWebhookToken(),
    },
  });

  return { ok: true };
};

export default function CoinsubSettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [merchantId, setMerchantId] = useState(loaderData.merchantId);
  const [apiKey, setApiKey] = useState("");

  return (
    <s-page heading="CoinSub Settings">
      <s-section heading="Merchant credentials">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field
              name="merchantId"
              label="Merchant ID"
              value={merchantId}
              onChange={(event) => setMerchantId(event.currentTarget.value)}
              autocomplete="off"
              error={actionData?.errors?.merchantId}
            ></s-text-field>

            <s-text-field
              name="apiKey"
            
              label="API Key"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              autocomplete="off"
              details="Leave blank to keep the currently saved key."
              error={actionData?.errors?.apiKey}
            ></s-text-field>

            <s-text-field
              name="webhookUrl"
              label="Webhook URL"
              value={loaderData.webhookUrl}
              readOnly
            ></s-text-field>

            {actionData?.ok && (
              <s-text tone="success">
                CoinSub settings saved successfully.
              </s-text>
            )}
            {loaderData.hasApiKey && !actionData?.ok && (
              <s-text>API key is already saved for this shop.</s-text>
            )}

            <s-button type="submit">Save settings</s-button>
          </s-stack>
        </Form>
      </s-section>
      <s-section heading="Recent payment statuses">
        <s-stack direction="block" gap="base">
          {loaderData.recentPayments.length === 0 ? (
            <s-text>No CoinSub payment records yet.</s-text>
          ) : (
            loaderData.recentPayments.map((payment: RecentPayment) => (
              <s-box key={payment.paymentId || `${payment.orderId}-${payment.updatedAt}`}>
                <s-text>
                  Payment: {payment.paymentId || "n/a"} | Order: {payment.orderId || "n/a"} | Status: {payment.status || "n/a"} | Amount: {payment.amount ?? 0} {payment.currency || ""}
                </s-text>
              </s-box>
            ))
          )}
        </s-stack>
      </s-section>
      <s-section heading="Recent refund transfer statuses">
        <s-stack direction="block" gap="base">
          {loaderData.recentTransfers.length === 0 ? (
            <s-text>No CoinSub transfer records yet.</s-text>
          ) : (
            loaderData.recentTransfers.map((transfer: RecentTransfer) => (
              <s-box key={transfer.transferId || `${transfer.orderId}-${transfer.updatedAt}`}>
                <s-text>
                  Transfer: {transfer.transferId || "pending"} | Payment: {transfer.paymentId || "n/a"} | Order: {transfer.orderId || "n/a"} | Status: {transfer.status || "n/a"} | Amount: {transfer.amount ?? 0} {transfer.token || ""}
                </s-text>
              </s-box>
            ))
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
