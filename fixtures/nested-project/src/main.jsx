import React from 'react';
import { t } from 'i18next';

// Navigation links
const NavBar = () => (
  <nav>
    <a href="/">{t("nav.home")}</a>
    <a href="/about">{t("nav.about")}</a>
    <a href="/contact">{t("nav.contact")}</a>
  </nav>
);

// Welcome banner
const Banner = ({ name }) => (
  <div>
    <h1>{t("msg.welcome")}</h1>
    <p>{t("msg.farewell")}</p>
    <span>{t("msg.count")}</span>
    <span>{t("msg.error")}</span>
  </div>
);

// Action buttons
const Actions = () => (
  <div>
    <button>{t("btn.save")}</button>
    <button>{t("btn.cancel")}</button>
    <button>{t("btn.delete")}</button>
  </div>
);

// Auth section
const Auth = () => (
  <div>
    <button>{t("auth.login")}</button>
    <button>{t("auth.logout")}</button>
    <a>{t("auth.register")}</a>
  </div>
);

// A key that doesn't exist in any locale
const UnknownWidget = () => <span>{t("unknown.widget.title")}</span>;

export { NavBar, Banner, Actions, Auth, UnknownWidget };
