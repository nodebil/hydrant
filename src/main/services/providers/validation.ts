import type { GameShop, SourceSearchRequest } from "@types";
import { SourceFetchError } from "../source-fetch/errors.js";

const GAME_SHOPS: readonly GameShop[] = [
  "steam",
  "epic",
  "custom",
  "launchbox",
];

const MAX_ID_LENGTH = 100;
const MAX_OBJECT_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_PROVIDER_IDS = 20;

const invalid = (message: string) =>
  new SourceFetchError("INVALID_INPUT", message);

const isGameShop = (value: unknown): value is GameShop =>
  typeof value === "string" && GAME_SHOPS.some((shop) => shop === value);

const readString = (
  value: unknown,
  field: string,
  maxLength: number
): string => {
  if (typeof value !== "string") throw invalid(`Invalid ${field}`);

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw invalid(`Invalid ${field}`);
  }

  return trimmed;
};

const readProviderIds = (value: unknown) => {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_IDS) {
    throw invalid("Invalid providerIds");
  }

  const ids = value.map((id) => readString(id, "providerIds", MAX_ID_LENGTH));
  if (new Set(ids).size !== ids.length) throw invalid("Duplicate providerIds");

  return ids;
};

export const validateSourceSearchRequest = (
  value: unknown
): SourceSearchRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Invalid search request");
  }

  const input = value as Record<string, unknown>;
  const shop = input.shop;
  if (!isGameShop(shop)) throw invalid("Invalid shop");

  const request: SourceSearchRequest = {
    requestId: readString(input.requestId, "requestId", MAX_ID_LENGTH),
    shop,
    objectId: readString(input.objectId, "objectId", MAX_OBJECT_ID_LENGTH),
    title: readString(input.title, "title", MAX_TITLE_LENGTH),
  };

  if (input.steamAppId !== undefined) {
    if (!Number.isInteger(input.steamAppId) || Number(input.steamAppId) <= 0) {
      throw invalid("Invalid steamAppId");
    }

    request.steamAppId = Number(input.steamAppId);
  }

  if (input.providerIds !== undefined) {
    request.providerIds = readProviderIds(input.providerIds);
  }

  return request;
};

export const validateRequestId = (value: unknown): string =>
  readString(value, "requestId", MAX_ID_LENGTH);
