// bb-plugin-walkthrough — frontend entry. The views live in views/; this file
// only registers where they appear.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ReviewsPage } from "./views/ReviewsPage";
import { WALKTHROUGH_TAB } from "./views/shared";
import {
  WalkthroughDirective,
  WalkthroughHeaderButton,
} from "./views/ThreadEntry";
import { WalkthroughTab } from "./views/WalkthroughTab";

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: WALKTHROUGH_TAB,
    title: "Walkthrough",
    icon: "FileDiff",
    layout: "flush",
    component: WalkthroughTab,
  });
  app.slots.experimental_threadHeaderAction({
    id: "walkthrough",
    title: "Walkthrough",
    component: WalkthroughHeaderButton,
  });
  app.slots.messageDirective({
    id: "walkthrough",
    component: WalkthroughDirective,
  });
  app.slots.navPanel({
    id: "reviews",
    title: "Reviews",
    icon: "FileDiff",
    path: "reviews",
    component: ReviewsPage,
  });
});
