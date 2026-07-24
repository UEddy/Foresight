const axios = require('axios');
const { sanitizeCopy } = require('./lib/sanitizeText');

// In dev, fall back to console logging when Resend rejects the recipient
// (onboarding@resend.dev can only deliver to the Resend account owner's email).
// Set RESEND_FROM to a verified-domain address (e.g. no-reply@yourdomain.com)
// before going to production.
const FROM = process.env.RESEND_FROM || 'Nivaria <onboarding@resend.dev>';

// Canonical brand logo for email: a hosted PNG lockup (the Nivaria monogram plus
// wordmark) served from the site's static assets at an absolute nivaria.app URL,
// so email clients can fetch it over the network. PNG is used deliberately, not
// SVG (many clients, notably Outlook, do not render SVG), and the wordmark font
// is baked into the image, so the email depends on neither SVG support nor web
// fonts. Always the production URL: localhost asset URLs are not reachable from
// a recipient's inbox, so this is the only URL that resolves in a real client.
const LOGO_URL = 'https://nivaria.app/assets/nivaria-email-logo.png';

// Shared branded header/footer. Inline styles only (email clients ignore
// stylesheets). The logo is an <img> with explicit width/height and alt text.
function brandHeader() {
  return `<tr><td style="padding:26px 36px 22px;border-bottom:1px solid #1A1A1A">
            <img src="${LOGO_URL}" alt="Nivaria" width="137" height="44"
                 style="display:block;border:0;outline:none;text-decoration:none;width:137px;height:44px">
          </td></tr>`;
}

function brandFooter() {
  return `<tr><td style="padding:18px 36px;border-top:1px solid #1A1A1A">
            <p style="margin:0;font-size:11.5px;color:#374151">Nivaria: Competitor Intelligence Platform</p>
          </td></tr>`;
}

// Calendar re-auth email body. Lives here with the other templates so every
// email shares the one branded header/footer. Called by calendarSync.js.
function buildCalendarReauthHtml({ name, provider, accountEmail, appUrl }) {
  const providerName = provider === 'google' ? 'Google' : 'Microsoft';
  const acct = accountEmail || 'unknown account';
  const reconnectUrl = `${appUrl}/app#/profile/integrations`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:48px 20px"><tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:16px;overflow:hidden;max-width:100%">
      ${brandHeader()}
      <tr><td style="padding:34px 36px 28px">
        <p style="margin:0 0 14px;font-size:21px;font-weight:800;color:#F1F5F9;letter-spacing:-0.5px">Re-connect your calendar</p>
        <p style="margin:0 0 16px;font-size:14px;color:#94A3B8;line-height:1.65">Hi ${name || 'there'},</p>
        <p style="margin:0 0 22px;font-size:14px;color:#94A3B8;line-height:1.65">
          Your ${providerName} Calendar connection (${acct}) expired and could not be refreshed automatically.
          Pre-meeting briefings will stop firing until you re-connect.
        </p>
        <a href="${reconnectUrl}" style="display:inline-block;background:#4338CA;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:10px">Re-connect now</a>
      </td></tr>
      ${brandFooter()}
    </table>
  </td></tr></table>
</body></html>`;
}

// ── OTP delivery (with graceful fallback) ──────────────────────────────────────
//
// Sends the OTP via Resend (the nivaria.app domain was verified in Phase 12D).
// If delivery fails for any reason (missing/bad key, timeout, network error) we
// log the error type, recipient, and purpose under [EMAIL_DELIVERY_FAILED] — but
// NEVER the OTP value itself. The code lives only in the database and in the
// delivered email; it must appear nowhere in our logs.
//
// The function swallows delivery failures and returns a non-throwing result so a
// transient error doesn't 500 the signup. The user simply sees that a code was
// sent and can use "Resend code" if it never arrives.
//
// (Phase 12, pre-12D temporarily logged the OTP to the console as a stopgap while
// the Resend domain was unverified; that logging was removed once it verified.)
async function sendOtpEmail(toEmail, code, purpose) {
  const subject = purpose === 'reset'
    ? 'Reset your Nivaria password'
    : 'Your Nivaria verification code';

  // No Resend key configured (e.g. local dev). Skip the network call. The OTP is
  // still available in the otp_codes table for anyone with DB access to test with.
  if (!process.env.RESEND_API_KEY) {
    console.error('[EMAIL_DELIVERY_FAILED]', { error: 'RESEND_API_KEY not configured', recipient: toEmail, purpose });
    return { fallback: true, delivered: false };
  }

  try {
    const resp = await axios.post(
      'https://api.resend.com/emails',
      {
        from: FROM,
        to: [toEmail],
        subject,
        html: buildHtml(code, purpose),
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );
    return { delivered: true, data: resp.data };
  } catch (err) {
    // Any Resend failure (bad key 401, timeout, network error). Log the error
    // type, recipient, and purpose for debugging — never the OTP — and do not
    // rethrow, so a transient delivery failure can't block signup.
    const errorMessage = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[EMAIL_DELIVERY_FAILED]', { error: errorMessage, recipient: toEmail, purpose });
    return { fallback: true, delivered: false };
  }
}

function buildHtml(code, purpose) {
  const actionText = purpose === 'reset'
    ? 'reset your password'
    : 'verify your email address';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:48px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
        style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:16px;overflow:hidden;max-width:100%">

        ${brandHeader()}

        <tr><td style="padding:36px 36px 28px">
          <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:#F1F5F9;letter-spacing:-0.5px">
            Your verification code
          </p>
          <p style="margin:0 0 30px;font-size:14px;color:#94A3B8;line-height:1.65">
            Use the code below to ${actionText}. It expires in <strong style="color:#F1F5F9">10&nbsp;minutes</strong>.
          </p>

          <div style="background:#000000;border:1px solid #222222;border-radius:12px;padding:30px 20px;text-align:center;margin-bottom:28px">
            <span style="font-size:46px;font-weight:800;letter-spacing:14px;color:#6366F1;font-family:'Courier New',Courier,monospace">
              ${code}
            </span>
          </div>

          <p style="margin:0;font-size:12.5px;color:#4B5563;line-height:1.6">
            If you did not request this, you can safely ignore this email.
            Do not share this code with anyone.
          </p>
        </td></tr>

        ${brandFooter()}

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Phase 10 — account-deletion confirmation with a cancellation link. The user
// can click the link within the 30-day grace period to restore their account.
async function sendAccountDeletionEmail(toEmail, cancelUrl, scheduledDate) {
  const when = scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate || '').slice(0, 10);
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:48px 20px"><tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:16px;overflow:hidden;max-width:100%">
      ${brandHeader()}
      <tr><td style="padding:36px 36px 28px">
        <p style="margin:0 0 6px;font-size:21px;font-weight:800;color:#F1F5F9;letter-spacing:-0.5px">We received your deletion request</p>
        <p style="margin:0 0 22px;font-size:14px;color:#94A3B8;line-height:1.65">
          Your Nivaria account and all associated data are scheduled to be permanently deleted on
          <strong style="color:#F1F5F9">${when}</strong> (30 days from now).
        </p>
        <p style="margin:0 0 24px;font-size:14px;color:#94A3B8;line-height:1.65">
          If you did not request this, or you changed your mind, click below to cancel and keep your account.
        </p>
        <a href="${cancelUrl}" style="display:inline-block;background:#6366F1;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 22px;border-radius:10px">Cancel deletion &amp; keep my account</a>
        <p style="margin:24px 0 0;font-size:12px;color:#4B5563;line-height:1.6">If the button doesn't work, paste this link into your browser:<br>${cancelUrl}</p>
      </td></tr>
      ${brandFooter()}
    </table>
  </td></tr></table>
</body></html>`;

  try {
    const resp = await axios.post('https://api.resend.com/emails',
      { from: FROM, to: [toEmail], subject: 'Your Nivaria account deletion request', html },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 });
    return resp.data;
  } catch (err) {
    const resendError = err.response?.data;
    if (process.env.NODE_ENV !== 'production' && resendError?.statusCode === 403 && resendError?.name === 'validation_error') {
      console.warn(`[DEV] Resend blocked deletion email to unverified domain. Cancellation link: ${cancelUrl}`);
      return { devFallback: true };
    }
    throw err;
  }
}

// ── Brief-notification delivery ────────────────────────────────────────────────
//
// Sends the generated brief to the user's notification address whenever a
// meaningful change is detected for a tracked competitor. Wired into the
// scheduler alongside the Slack/Discord alert dispatch, under the same
// meaningful-change and tier gating, so it fires once per generated brief.
//
// Robust like the OTP path: failures are logged under [EMAIL_DELIVERY_FAILED]
// with the error type and purpose only. The recipient address and the brief
// contents are never logged. The function never throws, so a transient delivery
// failure can't disrupt the monitoring pipeline.
//
// All model-authored fields (headline, summary, recommended response, talking
// points) are run through sanitizeCopy before rendering, per the no-dash and
// no-connector-plus rule for AI output (see CLAUDE.md).
async function sendBriefEmail(toEmail, { competitor, analysis, changeId }) {
  if (!process.env.RESEND_API_KEY) {
    console.error('[EMAIL_DELIVERY_FAILED]', { error: 'RESEND_API_KEY not configured', purpose: 'brief_notification' });
    return { fallback: true, delivered: false };
  }

  const subject = `Competitor brief: ${competitor.name}`;
  try {
    const resp = await axios.post(
      'https://api.resend.com/emails',
      {
        from: FROM,
        to: [toEmail],
        subject,
        html: buildBriefHtml(competitor, analysis, changeId),
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );
    return { delivered: true, data: resp.data };
  } catch (err) {
    const errorMessage = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[EMAIL_DELIVERY_FAILED]', { error: errorMessage, purpose: 'brief_notification' });
    return { fallback: true, delivered: false };
  }
}

function buildBriefHtml(competitor, analysis, changeId) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const briefUrl = `${appUrl}/app#/history/${changeId}`;

  const THREAT_HEX = { low: '#10B981', medium: '#F59E0B', high: '#EF4444' };
  const level = String(analysis.threat_level || 'medium').toLowerCase();
  const threatColor = THREAT_HEX[level] || '#6366F1';
  const threatLabel = level.toUpperCase();

  // Sanitize every model-authored field before it reaches the inbox.
  const name      = sanitizeCopy(competitor.name || 'Competitor');
  const headline  = sanitizeCopy(analysis.headline || 'A tracked competitor page changed.');
  const summary   = sanitizeCopy(analysis.summary || '');
  const action    = sanitizeCopy(analysis.recommended_response || '');
  const points    = Array.isArray(analysis.talking_points) ? analysis.talking_points : [];

  const pointsHtml = points.length
    ? `<table cellpadding="0" cellspacing="0" style="margin:8px 0 0">
        ${points.map(p => `
          <tr>
            <td style="vertical-align:top;padding:4px 10px 4px 0;color:#6366F1;font-size:14px;line-height:1.6">&bull;</td>
            <td style="padding:4px 0;color:#94A3B8;font-size:14px;line-height:1.6">${sanitizeCopy(String(p))}</td>
          </tr>`).join('')}
      </table>`
    : '';

  const section = (label, body) => body
    ? `<p style="margin:24px 0 6px;font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6366F1">${label}</p>
       <p style="margin:0;font-size:14px;color:#94A3B8;line-height:1.65">${body}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:48px 20px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0"
        style="background:#0A0A0A;border:1px solid #1A1A1A;border-radius:16px;overflow:hidden;max-width:100%">

        ${brandHeader()}

        <tr><td style="padding:34px 36px 30px">
          <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#64748B;letter-spacing:0.3px">
            New competitor brief
          </p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>
            <td style="font-size:22px;font-weight:800;color:#F1F5F9;letter-spacing:-0.5px;padding-right:10px">${name}</td>
            <td style="vertical-align:middle">
              <span style="display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:0.5px;color:${threatColor};background:${threatColor}22;border:1px solid ${threatColor}55;border-radius:999px;padding:3px 9px">${threatLabel} THREAT</span>
            </td>
          </tr></table>

          <p style="margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6366F1">What changed</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#F1F5F9;line-height:1.5">${headline}</p>

          ${section('Executive summary', summary)}
          ${section('Recommended response', action)}
          ${points.length ? `<p style="margin:24px 0 0;font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6366F1">Key talking points</p>${pointsHtml}` : ''}

          <table cellpadding="0" cellspacing="0" style="margin:30px 0 0"><tr><td>
            <a href="${briefUrl}" style="display:inline-block;background:#4338CA;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:13px 24px;border-radius:10px">View full brief</a>
          </td></tr></table>
          <p style="margin:18px 0 0;font-size:12px;color:#4B5563;line-height:1.6">
            You receive this because brief notifications are on for your workspace. You can turn them off in Settings, Notifications.
          </p>
        </td></tr>

        ${brandFooter()}

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Trial lifecycle emails ─────────────────────────────────────────────────────
// Three short transactional notices sent by the daily trial sweep
// (src/scheduler.js runTrialSweep): a heads-up on day 10, a final notice on day
// 13, and the expiry notice. Each states plainly what the account keeps: no
// lockout, data intact, Free plan limits. Copy is deliberately short and uses
// no em-dashes or en-dashes (CLAUDE.md).
const TRIAL_EMAIL_COPY = {
  day10: {
    subject: (daysLeft) => `${daysLeft} days left in your Nivaria Pro trial`,
    heading: 'Your trial is winding down',
    body: (daysLeft) => `You have ${daysLeft} days left in your 14-day Pro trial. After that you stay on the Free plan with 1 monitored competitor, manual checks, and AI briefs by email. Nothing gets deleted. To keep daily monitoring on up to 15 pages, upgrade to Pro for $20 a month.`,
    cta: 'Upgrade to Pro',
  },
  day13: {
    subject: () => 'Your Nivaria trial ends tomorrow',
    heading: 'Last day of Pro',
    body: () => 'Your 14-day Pro trial ends tomorrow. After that you stay on the Free plan: 1 monitored competitor, manual checks, and AI briefs by email. Your account, briefs, and competitors are all kept. Upgrade to Pro for $20 a month to keep daily monitoring on up to 15 pages.',
    cta: 'Upgrade to Pro',
  },
  expiry: {
    subject: () => 'Your Nivaria trial ended. Your account is still active.',
    heading: 'You are now on the Free plan',
    body: () => 'Your Pro trial has ended and your account moved to the Free plan. You keep 1 monitored competitor, manual checks, and AI briefs by email. Competitors above the Free limit are archived, not deleted, and come back the moment you upgrade. Pro is $20 a month.',
    cta: 'Upgrade to Pro',
  },
};

async function sendTrialEmail(toEmail, { variant, daysLeft }) {
  const copy = TRIAL_EMAIL_COPY[variant];
  if (!copy) throw new Error(`unknown trial email variant: ${variant}`);
  const subject = copy.subject(daysLeft);
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const upgradeUrl = `${appUrl}/app#/settings`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:48px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border:1px solid #222233;border-radius:16px;padding:40px 36px">
        <tr><td align="center" style="padding-bottom:20px">
          <img src="${LOGO_URL}" alt="Nivaria" width="120" style="display:block">
        </td></tr>
        <tr><td style="color:#F0F0F8;font-size:20px;font-weight:700;padding-bottom:12px" align="center">${copy.heading}</td></tr>
        <tr><td style="color:#888899;font-size:14px;line-height:1.7;padding-bottom:24px" align="center">${copy.body(daysLeft)}</td></tr>
        <tr><td align="center">
          <a href="${upgradeUrl}" style="display:inline-block;background:#4338CA;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:10px">${copy.cta}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  if (!process.env.RESEND_API_KEY) {
    console.error('[EMAIL_DELIVERY_FAILED]', { error: 'RESEND_API_KEY not configured', recipient: toEmail, purpose: `trial_${variant}` });
    return { fallback: true, delivered: false };
  }
  try {
    const resp = await axios.post(
      'https://api.resend.com/emails',
      { from: FROM, to: [toEmail], subject, html },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    return { delivered: true, data: resp.data };
  } catch (err) {
    const errorMessage = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[EMAIL_DELIVERY_FAILED]', { error: errorMessage, recipient: toEmail, purpose: `trial_${variant}` });
    return { fallback: true, delivered: false };
  }
}

module.exports = { sendOtpEmail, sendAccountDeletionEmail, sendBriefEmail, sendTrialEmail, buildBriefHtml, buildCalendarReauthHtml, LOGO_URL, TRIAL_EMAIL_COPY };
