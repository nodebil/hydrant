import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { Tooltip } from "react-tooltip";
import { filterDownloadableRepacks } from "@shared";
import type {
  GameRepack,
  SourceGameRepack,
  SourceProviderId,
  SourceSearchResult,
} from "@types";

import { Button } from "@renderer/components";
import { gameDetailsContext } from "@renderer/context";
import { useDate, useFeature } from "@renderer/hooks";
import { logger } from "@renderer/logger";

import { getRepackAvailabilityStatus } from "./repack-availability";
import { getSourceSearchOutcome } from "./source-repacks-state";
import "./source-repacks-section.scss";

type SourceSearchPhase =
  | "idle"
  | "searching"
  | "done"
  | "failed"
  | "unsupported"
  | "unavailable";

export interface SourceRepacksSectionProps {
  onSelectRepack: (repack: GameRepack) => void;
}

export function SourceRepacksSection({
  onSelectRepack,
}: Readonly<SourceRepacksSectionProps>) {
  const { t } = useTranslation("game_details");
  const { formatDate } = useDate();
  const { isFeatureEnabled, Feature } = useFeature();
  const { game, gameTitle, objectId, shop } = useContext(gameDetailsContext);

  const [sourceRepacks, setSourceRepacks] = useState<SourceGameRepack[]>([]);
  const [availableProviderIds, setAvailableProviderIds] = useState<
    SourceProviderId[] | null
  >(null);
  const [searchPhase, setSearchPhase] = useState<SourceSearchPhase>("idle");
  const [isSearching, setIsSearching] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const contentId = useId();
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const refocusToggleRef = useRef(false);

  const cancelSearch = useCallback(() => {
    const requestId = requestIdRef.current;
    requestIdRef.current = null;

    if (requestId) {
      void window.electron
        .cancelSourceProviderSearch(requestId)
        .catch(() => {});
    }
  }, []);

  useEffect(() => cancelSearch, [cancelSearch]);

  useEffect(() => {
    collapseRef.current?.toggleAttribute("inert", !isExpanded);
  }, [isExpanded]);

  useEffect(() => {
    window.electron
      .getSourceProviderAvailability()
      .then(setAvailableProviderIds)
      .catch((error) => {
        logger.error(error);
        setAvailableProviderIds([]);
      });
  }, []);

  useEffect(() => {
    if (!isSearching && refocusToggleRef.current) {
      refocusToggleRef.current = false;
      toggleButtonRef.current?.focus();
    }
  }, [isSearching]);

  if (!availableProviderIds?.length) return null;

  const multipartHosterDownloads = isFeatureEnabled(
    Feature.MultipartHosterDownloads
  );
  const requestObjectId = game?.objectId ?? objectId;
  const requestShop = game?.shop ?? shop;
  const requestTitle = game?.title ?? gameTitle;
  const canSearch = Boolean(requestObjectId && requestTitle);
  const steamAppIdNumber =
    requestShop === "steam" ? Number(requestObjectId) : Number.NaN;
  const steamAppId =
    Number.isSafeInteger(steamAppIdNumber) && steamAppIdNumber > 0
      ? steamAppIdNumber
      : undefined;

  const handleSearch = async () => {
    if (isSearching || !requestObjectId || !requestTitle) return;

    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    setSourceRepacks([]);
    setSearchPhase("searching");
    setIsSearching(true);

    try {
      const results = await window.electron.searchSourceProviders({
        requestId,
        shop: requestShop,
        objectId: requestObjectId,
        title: requestTitle,
        ...(steamAppId ? { steamAppId } : {}),
      });

      if (requestIdRef.current !== requestId) return;

      const preparedResults = results.map((result): SourceSearchResult => {
        const repacks = filterDownloadableRepacks(
          result.repacks,
          multipartHosterDownloads
        );

        if (result.status === "ok" && repacks.length === 0) {
          return {
            ...result,
            repacks,
            status: "unsupported",
            errorCode: "UNSUPPORTED_HOSTER",
          };
        }

        return { ...result, repacks };
      });

      setSourceRepacks(preparedResults.flatMap((result) => result.repacks));

      const outcome = getSourceSearchOutcome(preparedResults);
      setSearchPhase(outcome);

      if (outcome === "failed" || outcome === "unsupported") {
        refocusToggleRef.current = true;
      }
    } catch {
      if (requestIdRef.current !== requestId) return;

      setSearchPhase("failed");
      refocusToggleRef.current = true;
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = null;
        setIsSearching(false);
      }
    }
  };

  const handleToggle = () => {
    const next = !isExpanded;
    setIsExpanded(next);

    if (next && searchPhase === "idle") {
      void handleSearch();
    }
  };

  const handleCancel = () => {
    cancelSearch();
    setIsSearching(false);
    setSearchPhase("idle");
    setIsExpanded(false);
    refocusToggleRef.current = true;
  };

  return (
    <section className="source-repacks">
      <button
        ref={toggleButtonRef}
        type="button"
        className="source-repacks__toggle"
        aria-expanded={isExpanded}
        aria-controls={contentId}
        disabled={!canSearch}
        onClick={handleToggle}
      >
        <span className="source-repacks__toggle-title">
          {t("source_search_title")}
        </span>
        <span className="source-repacks__toggle-icons">
          {isSearching && !isExpanded && (
            <SyncIcon className="source-repacks__spinner" size={14} />
          )}
          {isExpanded ? (
            <ChevronUpIcon className="source-repacks__toggle-icon" />
          ) : (
            <ChevronDownIcon className="source-repacks__toggle-icon" />
          )}
        </span>
      </button>

      <div
        ref={collapseRef}
        id={contentId}
        className={`source-repacks__collapse ${
          isExpanded ? "source-repacks__collapse--open" : ""
        }`}
        aria-hidden={!isExpanded}
      >
        <div className="source-repacks__content">
          {isSearching && (
            <div
              className="source-repacks__loading"
              role="status"
              aria-label={t("source_searching")}
            >
              <SyncIcon className="source-repacks__spinner" />
              <Button theme="outline" size="small" onClick={handleCancel}>
                {t("source_search_cancel")}
              </Button>
            </div>
          )}

          {searchPhase === "failed" && (
            <div
              className="source-repacks__notice source-repacks__notice--error"
              role="alert"
            >
              <span>{t("source_search_error")}</span>
              <Button
                theme="outline"
                size="small"
                onClick={() => void handleSearch()}
              >
                <SyncIcon />
                {t("source_search_retry")}
              </Button>
            </div>
          )}

          {searchPhase === "unsupported" && (
            <div className="source-repacks__notice" role="status">
              <span>{t("source_search_unsupported_hoster_notice")}</span>
              <Button
                theme="outline"
                size="small"
                onClick={() => void handleSearch()}
              >
                <SyncIcon />
                {t("source_search_retry")}
              </Button>
            </div>
          )}

          {searchPhase === "done" && sourceRepacks.length === 0 && (
            <div className="source-repacks__notice" role="status">
              <span>{t("source_search_empty")}</span>
              <Button
                theme="outline"
                size="small"
                onClick={() => void handleSearch()}
              >
                <SyncIcon />
                {t("source_search_retry")}
              </Button>
            </div>
          )}

          {searchPhase === "unavailable" && (
            <div className="source-repacks__notice" role="status">
              {t("source_search_unavailable")}
            </div>
          )}

          {sourceRepacks.length > 0 && (
            <div className="repacks-modal__repacks">
              {sourceRepacks.map((repack, index) => {
                const availabilityStatus = getRepackAvailabilityStatus(repack);
                const tooltipId = `source-availability-orb-${index}`;
                const build =
                  repack.build && !repack.title.includes(repack.build)
                    ? repack.build
                    : null;
                const info = [
                  repack.fileSize,
                  repack.downloadSourceName,
                  build,
                  repack.uploadDate ? formatDate(repack.uploadDate) : null,
                ]
                  .filter((value): value is string => Boolean(value))
                  .join(" - ");

                return (
                  <Button
                    key={repack.id}
                    theme="dark"
                    onClick={() => onSelectRepack(repack)}
                    className="repacks-modal__repack-button"
                  >
                    <span
                      className={`repacks-modal__availability-orb repacks-modal__availability-orb--${availabilityStatus}`}
                      data-tooltip-id={tooltipId}
                      data-tooltip-content={t(`source_${availabilityStatus}`)}
                    />
                    <Tooltip id={tooltipId} />

                    <p className="repacks-modal__repack-title">
                      {repack.title}
                    </p>

                    {info && (
                      <p className="repacks-modal__repack-info">{info}</p>
                    )}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
