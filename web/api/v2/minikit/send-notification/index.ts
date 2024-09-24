import { errorResponse } from "@/api/helpers/errors";
import { getAPIServiceGraphqlClient } from "@/api/helpers/graphql";
import { verifyHashedSecret } from "@/api/helpers/utils";
import { validateRequestSchema } from "@/api/helpers/validate-request-schema";
import { notificationPermissions } from "@/lib/constants";
import { createSignedFetcher } from "aws-sigv4-fetch";
import { NextRequest, NextResponse } from "next/server";
import * as yup from "yup";
import { getSdk as fetchApiKeySdk } from "../graphql/fetch-api-key.generated";
import { getSdk as fetchMetadataSdk } from "./graphql/fetch-metadata.generated";

const sendNotificationBodySchema = yup.object({
  app_id: yup.string().strict().required(),
  wallet_addresses: yup.array().of(yup.string()),
  message: yup.string().strict().required(),
  title: yup.string().strict().optional(),
  mini_app_path: yup.string().strict().required(),
});

// TODO: Open to outside of studios and check permissions
export const POST = async (req: NextRequest) => {
  const api_key = req.headers.get("authorization")?.split(" ")[1];

  if (
    !process.env.NEXT_PUBLIC_APP_ENV ||
    !["dev", "staging", "production"].includes(process.env.NEXT_PUBLIC_APP_ENV)
  ) {
    return errorResponse({
      statusCode: 400,
      code: "invalid_request",
      detail: "Invalid Environment Configuration",
      attribute: "app_env",
      req,
    });
  }

  if (!api_key) {
    return errorResponse({
      statusCode: 401,
      code: "unauthorized",
      detail: "API key is required.",
      attribute: "api_key",
      req,
    });
  }
  const body = await req.json();

  const { isValid, parsedParams, handleError } = await validateRequestSchema({
    schema: sendNotificationBodySchema,
    value: body,
  });

  if (!isValid) {
    return handleError(req);
  }

  const { app_id, wallet_addresses, title, message, mini_app_path } = {
    ...parsedParams,
  };

  const keyValue = api_key.replace(/^api_/, "");
  const serviceClient = await getAPIServiceGraphqlClient();

  const base64ApiKey = Buffer.from(keyValue, "base64").toString("utf8");
  const [id, secret] = base64ApiKey.split(":");

  const { api_key_by_pk } = await fetchApiKeySdk(serviceClient).FetchAPIKey({
    id,
    appId: app_id,
  });

  if (!api_key_by_pk) {
    return errorResponse({
      statusCode: 404,
      code: "not_found",
      detail: "API key not found.",
      attribute: "api_key",
      req,
    });
  }

  if (!api_key_by_pk.is_active) {
    return errorResponse({
      statusCode: 400,
      code: "api_key_inactive",
      detail: "API key is inactive.",
      attribute: "api_key",
      req,
    });
  }

  if (!api_key_by_pk.team.apps.some((a) => a.id === app_id)) {
    return errorResponse({
      statusCode: 403,
      code: "invalid_app",
      detail: "API key is not valid for this app.",
      attribute: "api_key",
      req,
    });
  }

  const isAPIKeyValid = verifyHashedSecret(
    api_key_by_pk.id,
    secret,
    api_key_by_pk.api_key,
  );

  if (!isAPIKeyValid) {
    return errorResponse({
      statusCode: 403,
      code: "invalid_api_key",
      detail: "API key is not valid.",
      attribute: "api_key",
      req,
    });
  }

  // Anchor: Check Permissions
  const { app_metadata } = await fetchMetadataSdk(serviceClient).GetAppMetadata(
    {
      app_id,
    },
  );

  const appMetadata = app_metadata?.[0];
  const teamId = appMetadata.app.team.id;
  if (
    !notificationPermissions[
      process.env.NEXT_PUBLIC_APP_ENV as "staging" | "production"
    ].includes(teamId)
  ) {
    return errorResponse({
      statusCode: 403,
      code: "forbidden",
      detail: "You are not allowed to send notifications.",
      attribute: "team_id",
      req,
    });
  }

  // Anchor: Send notification

  const signedFetch = createSignedFetcher({
    service: "execute-api",
    region: process.env.TRANSACTION_BACKEND_REGION,
  });

  const res = await signedFetch(
    `${process.env.NEXT_PUBLIC_SEND_NOTIFICATION_ENDPOINT}`,
    {
      method: "POST",
      headers: {
        "User-Agent": req.headers.get("user-agent") ?? "DevPortal/1.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appId: app_id,
        walletAddresses: wallet_addresses,
        title,
        message,
        miniAppPath: mini_app_path,
        maxNotificationsPerDay: 1,
        isAllowedUnlimitedNotifications: true, // This is temporary while the API is restricted to studios
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) {
    console.warn("Error sending notification", data);

    let errorMessage;
    if (data && data.error) {
      errorMessage = data.error.message;
    } else {
      errorMessage = "Server Error Occured";
    }

    return errorResponse({
      statusCode: res.status,
      code: data.error.code ?? "internal_api_error",
      detail: errorMessage,
      attribute: "notification",
      req,
    });
  }

  return NextResponse.json({ success: true, status: 200 });
};
