import { t } from 'i18next';

// Main component translations
const greeting = t("greeting");
const farewell = t("farewell");

// Navigation
const homeLabel = t("nav.home");
const aboutLabel = t("nav.about");
const contactLabel = t("nav.contact");

// Messages
const welcome = t("msg.welcome");
const count = t("msg.count");
const errorMsg = t("msg.error");

// Buttons
const saveBtn = t("btn.save");
const cancelBtn = t("btn.cancel");
const deleteBtn = t("btn.delete");

// Key that exists in no locale (intentionally missing)
const missingKey = t("missing.key");

// Another missing key using T() variant
const anotherMissing = T("another.missing");

export { greeting, farewell, homeLabel, aboutLabel, contactLabel, welcome, count, errorMsg, saveBtn, cancelBtn, deleteBtn, missingKey, anotherMissing };
