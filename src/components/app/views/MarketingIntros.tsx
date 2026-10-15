"use client";

// First screens for the marketing platform's tools, shown until each one has data
// (docs/marketing-platform.md). Each tool replaces its intro with the working screen when it ships.

import { BarChart, Branch, Eye, FileText } from "../../Icons";
import { SampleBars, SampleRows, SampleStats, SampleTags, ToolIntro } from "../ToolIntro";
import { Page } from "../ui";

export function VisitorsView() {
  return (
    <Page icon={<Eye size={14} />} title="Visitors">
      <ToolIntro
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

export function JourneysView() {
  return (
    <Page icon={<Branch size={14} />} title="Journeys">
      <ToolIntro
        title="Journeys that think for each contact"
        lead="Set the goal and the paths. Agent steps pick the next move for each contact and write each email from your own content. You approve before anything sends."
        features={[
          {
            title: "Agent decides",
            text: "Picks one of the paths you defined, with the reason, from what the contact did.",
            visual: <SampleRows rows={[["Sales-ready", 7, "7"], ["Keep nurturing", 18, "18"], ["Not now", 4, "4"]]} />,
          },
          {
            title: "Agent writes",
            text: "One-to-one emails in your voice. Every claim comes from your Brand Brain, with its source.",
            visual: <SampleStats items={[["written", "1,240"], ["approved", "96%"], ["replies", "8.1%"]]} />,
          },
          {
            title: "You stay in charge",
            text: "Review every email at first. Trust grows with each approval, one journey at a time.",
            visual: <SampleTags rows={[["Guide follow-up", "Review all"], ["Webinar no-shows", "Sample"], ["Trial nudge", "Auto"]]} />,
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
        title="Pages and forms that convert"
        lead="AI builds landing pages and forms from your content, shapes them for each segment or account, and checks that every form reaches your CRM."
        features={[
          {
            title: "Built from your content",
            text: "Pages made from your proof points and case studies, in your brand. No made-up claims.",
            visual: <SampleBars values={[22, 28, 31, 35, 33, 41, 46, 44, 52, 57, 55, 63]} />,
          },
          {
            title: "Smart forms",
            text: "Known contacts aren't asked twice. Consent wording follows the visitor's region. Visitors book with the right rep at once.",
            visual: <SampleStats items={[["views", "3,420"], ["submits", "312"], ["booked", "41"]]} />,
          },
          {
            title: "Checked in a real browser",
            text: "Every page, link and form is tested before launch and on a schedule after.",
            visual: <SampleTags rows={[["Demo form → Omniscient", "Passing"], ["Pricing page", "Passing"], ["Guide download", "Broken link"]]} />,
          },
        ]}
      />
    </Page>
  );
}

export function ReportsView() {
  return (
    <Page icon={<BarChart size={14} />} title="Reports">
      <ToolIntro
        title="See what made revenue"
        lead="Trace pipeline from AI answers and search, through visits, journeys and pages, to deals won in Omniscient."
        features={[
          {
            title: "Pipeline by source",
            text: "AI answers count as a channel, next to search, ads and email.",
            visual: <SampleRows rows={[["AI answers", 42, "$42k"], ["Organic search", 35, "$35k"], ["Journeys", 28, "$28k"]]} />,
          },
          {
            title: "Journeys and pages",
            text: "Goal rate, pipeline and revenue for each journey, step, page and form.",
            visual: <SampleBars values={[12, 18, 15, 22, 27, 25, 31, 36, 33, 40, 44, 48]} />,
          },
          {
            title: "A weekly summary",
            text: "What worked and what didn't, every Monday, with the numbers behind each point.",
            visual: <SampleStats items={[["meetings", "+18%"], ["handoffs", "64"], ["won", "$96k"]]} />,
          },
        ]}
      />
    </Page>
  );
}
