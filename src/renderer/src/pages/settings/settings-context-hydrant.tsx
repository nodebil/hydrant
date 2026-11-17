import { useTranslation } from "react-i18next";

import { CheckboxField } from "@renderer/components";
import { useHydrantPreferences } from "@renderer/hooks";

export function SettingsContextHydrant() {
  const { t } = useTranslation("settings");
  const { preferences, updatePreferences } = useHydrantPreferences();

  return (
    <div className="settings-context-panel">
      <p>{t("hydrant_description")}</p>

      <div className="settings-context-panel__group">
        <h3>{t("hydrant_tweaks")}</h3>

        <CheckboxField
          label={t("hydrant_steam_metadata")}
          checked={preferences.steamMetadata}
          onChange={() =>
            updatePreferences({ steamMetadata: !preferences.steamMetadata })
          }
        />

        <CheckboxField
          label={t("hydrant_hide_leaderboards")}
          checked={preferences.hideLeaderboards}
          onChange={() =>
            updatePreferences({
              hideLeaderboards: !preferences.hideLeaderboards,
            })
          }
        />

        <CheckboxField
          label={t("hydrant_hide_ranking_card")}
          checked={preferences.hideRankingCard}
          onChange={() =>
            updatePreferences({ hideRankingCard: !preferences.hideRankingCard })
          }
        />

        <CheckboxField
          label={t("hydrant_hide_feedback_widget")}
          checked={preferences.hideFeedbackWidget}
          onChange={() =>
            updatePreferences({
              hideFeedbackWidget: !preferences.hideFeedbackWidget,
            })
          }
        />
      </div>
    </div>
  );
}
