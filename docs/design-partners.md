# Design partners

Goal: 10 teams using Claritia every week, who tell us what breaks. Each gets Team free for 3 months.

## Who to ask

- Perceptric clients who ship web apps and have no QA person
- Startups with 2 to 30 engineers that ship every day
- Founders building with Claude Code or Cursor

Pick teams with a live sign-up or checkout flow, so their first test matters.

## The invite

> Subject: Free Claritia Team plan for 3 months?
>
> Hi {name},
>
> I'm building Claritia, a tool that tests your web app from plain English. You write "sign up, enter the code from the email, check the dashboard shows", and it writes the Playwright test, runs it in a real browser, and saves the video.
>
> I'm looking for 10 teams to use it for 3 months for free, on the Team plan. In return, I'd like a 20-minute call every two weeks about what's broken or missing.
>
> Want in? You can be running your first test in 5 minutes: https://app.tryclaritia.com
>
> {your name}

## Give a partner the Team plan

In the Supabase SQL editor, with their workspace name:

```sql
insert into workspace_billing (workspace_id, plan)
select id, 'team' from workspaces where name = 'their workspace'
on conflict (workspace_id) do update set plan = 'team';
```

Set it back to `'free'` when the 3 months end. A partner who pays later goes through Stripe as usual.

## Track

| Team | Asked | Said yes | First passing test | Weekly runs | Notes |
|---|---|---|---|---|---|
| | | | | | |

`workspaces.first_pass_at` shows when each team got its first passing test (see "Launch numbers" in the README).
