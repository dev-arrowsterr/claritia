"use client";

// First screens for the marketing platform's tools, shown until each one has data
// (docs/marketing-platform.md). Each tool replaces its intro with the working screen when it ships.

import { BarChart, Branch, Eye, FileText, FormIcon, Mail, Megaphone } from "../../Icons";
import { SampleBars, SampleRows, SampleStats, SampleTags, ToolIntro } from "../ToolIntro";
import { Page } from "../ui";

/** Visitors before a site is added. */
export function VisitorsIntro({ action }: { action?: React.ReactNode }) {
  return (
    <Page icon={<Eye size={14} />} title="Visits">
      <ToolIntro
        action={action}
        title="See which companies visit your site"
        lead="Claritia names the companies and people behind your traffic, shows what they read, and tells you when an account heats up. It follows each region's privacy rules on its own."
        features={[
          {
            title: "Live visitors",
            text: "Every visit with its company, pages and time on page, as it happens.",
            visual: <SampleRows rows={[["Acme · Pricing, Security", 9, "4m"], ["Globex · Case studies", 6, "2m"], ["Unknown · Germany", 3, "40s"]]} />,
          },
          {
            title: "Hot accounts",
            text: "Fit and intent scores, with the reasons behind them, so you know who to call today.",
            visual: <SampleTags rows={[["Acme", "Evaluating"], ["Initech", "Researching"], ["Globex", "Engaged"]]} />,
          },
          {
            title: "People, with proof",
            text: "Forms, sign-ins and email clicks tie visits to people. Every link shows the evidence behind it, and can be undone.",
            visual: <SampleTags rows={[["jane@acme.com", "Verified"], ["raj@acme.com", "Asserted"], ["Shared laptop", "Probable"]]} />,
          },
        ]}
      />
    </Page>
  );
}

export function TemplatesView() {
  return (
    <Page icon={<Mail size={14} />} title="Templates">
      <ToolIntro
        title="Emails in your brand"
        lead="Build email templates once, in your colors and voice. Workflows fill them for each contact."
        features={[
          {
            title: "Your brand kit",
            text: "Logo, colors and fonts come from your site.",
            visual: <SampleTags rows={[["Product update", "Ready"], ["Webinar invite", "Draft"], ["Guide follow-up", "Ready"]]} />,
          },
          {
            title: "Written for each contact",
            text: "AI blocks write a line or a paragraph from what the contact did, with the source behind each claim.",
            visual: <SampleStats items={[["templates", "12"], ["AI blocks", "31"], ["approved", "96%"]]} />,
          },
        ]}
      />
    </Page>
  );
}

export function WorkflowsView() {
  return (
    <Page icon={<Branch size={14} />} title="Workflows">
      <ToolIntro
        title="Workflows that think for each contact"
        lead="Start from a segment, a form or a visit. Agent steps pick the next move for each contact and write each email. You approve before anything sends."
        features={[
          {
            title: "Agent decides",
            text: "Picks one of the paths you defined, with the reason, from what the contact did.",
            visual: <SampleRows rows={[["Sales-ready", 7, "7"], ["Keep nurturing", 18, "18"], ["Not now", 4, "4"]]} />,
          },
          {
            title: "You stay in charge",
            text: "Review every email at first. Trust grows with each approval, one workflow at a time.",
            visual: <SampleTags rows={[["Guide follow-up", "Review all"], ["Webinar no-shows", "Sample"], ["Trial nudge", "Auto"]]} />,
          },
        ]}
      />
    </Page>
  );
}

export function AnalyticsView() {
  return (
    <Page icon={<BarChart size={14} />} title="Analytics">
      <ToolIntro
        title="See which emails made revenue"
        lead="Opens, clicks, replies and meetings for every workflow and template, traced to the opportunities they touched."
        features={[
          {
            title: "Pipeline by workflow",
            text: "Opportunities and revenue each workflow touched, from your CRM.",
            visual: <SampleRows rows={[["Guide follow-up", 42, "$42k"], ["Webinar no-shows", 35, "$35k"], ["Trial nudge", 28, "$28k"]]} />,
          },
          {
            title: "Every send",
            text: "Delivered, opened, clicked and replied, by template and by step.",
            visual: <SampleBars values={[12, 18, 15, 22, 27, 25, 31, 36, 33, 40, 44, 48]} />,
          },
        ]}
      />
    </Page>
  );
}

export function FormsView() {
  return (
    <Page icon={<FormIcon size={14} />} title="Forms">
      <ToolIntro
        title="Forms that fill your CRM"
        lead="Every submit creates or updates a contact, starts a workflow and reaches your CRM."
        features={[
          {
            title: "Smart forms",
            text: "Known contacts aren't asked twice. Consent wording follows the visitor's region.",
            visual: <SampleStats items={[["views", "3,420"], ["submits", "312"], ["booked", "41"]]} />,
          },
          {
            title: "Checked in a real browser",
            text: "Every form is tested before launch and on a schedule after.",
            visual: <SampleTags rows={[["Demo form → HubSpot", "Passing"], ["Newsletter", "Passing"], ["Guide download", "Broken"]]} />,
          },
        ]}
      />
    </Page>
  );
}

export function PagesView() {
  return (
    <Page icon={<FileText size={14} />} title="Pages">
      <ToolIntro
        title="Landing pages that convert"
        lead="AI builds landing pages from your content, shapes them for each segment or account, and holds your forms."
        features={[
          {
            title: "Built from your content",
            text: "Pages made from your proof points and case studies, in your brand. No made-up claims.",
            visual: <SampleBars values={[22, 28, 31, 35, 33, 41, 46, 44, 52, 57, 55, 63]} />,
          },
          {
            title: "One page per segment",
            text: "Headlines and proof change for each industry, size or account.",
            visual: <SampleTags rows={[["Pricing · SaaS", "Live"], ["Pricing · Retail", "Live"], ["Demo · Acme", "Draft"]]} />,
          },
        ]}
      />
    </Page>
  );
}

export function AdsView() {
  return (
    <Page icon={<Megaphone size={14} />} title="Ads">
      <ToolIntro
        title="Ads tied to pipeline"
        lead="Connect your ad accounts to see spend, leads and opportunities for every campaign, and send your segments as audiences."
        features={[
          {
            title: "Spend to revenue",
            text: "Cost per lead, per meeting and per opportunity, by campaign.",
            visual: <SampleRows rows={[["Google · Brand", 42, "$1.2k"], ["LinkedIn · ABM", 35, "$3.4k"], ["Meta · Retarget", 18, "$0.6k"]]} />,
          },
          {
            title: "Segments as audiences",
            text: "Your segments stay in step with each ad platform.",
            visual: <SampleTags rows={[["Hot accounts", "Google Ads"], ["Trial users", "Meta"], ["Target list", "LinkedIn"]]} />,
          },
        ]}
      />
    </Page>
  );
}
