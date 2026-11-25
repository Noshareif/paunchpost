import {
  SESv2Client,
  CreateConfigurationSetCommand,
  GetConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { SNSClient, CreateTopicCommand, SetTopicAttributesCommand, SubscribeCommand, ListSubscriptionsByTopicCommand } from "@aws-sdk/client-sns";
import { db, getSetting } from "./db";
import { baseUrl } from "./send";
import { secret } from "./secrets";

// The bounce & complaint feed: Amazon SES → SNS topic → /api/ses/events.
// Set up with the app's own AWS key, so no secrets ever pass through a person.

export const CONFIG_SET = "paunchpost";
const TOPIC = "paunchpost-ses-events";
const DEST = "paunchpost-sns";
const region = () => process.env.SES_REGION || "us-east-2";
const endpoint = () => (process.env.SES_ENDPOINT ? { endpoint: process.env.SES_ENDPOINT } : {});
const sesv2 = () => new SESv2Client({ region: region(), ...endpoint() });
const sns = () => new SNSClient({ region: region(), ...(process.env.SNS_ENDPOINT ? { endpoint: process.env.SNS_ENDPOINT } : endpoint()) });

async function setSetting(key: string, value: unknown) {
  const sql = db();
  await sql`insert into settings (key, value) values (${key}, ${sql.json(value as any)}) on conflict (key) do update set value = excluded.value`;
}

export function webhookUrl() {
  return `${baseUrl()}/api/ses/events?key=${secret("SES_WEBHOOK_KEY")}`;
}

/** Creates (or repairs) the configuration set, SNS topic, event destination and webhook subscription. */
export async function connectFeed() {
  const ses = sesv2();
  try {
    await ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: CONFIG_SET }));
  } catch (e: any) {
    if (e?.name !== "NotFoundException") throw e;
    await ses.send(
      new CreateConfigurationSetCommand({
        ConfigurationSetName: CONFIG_SET,
        SendingOptions: { SendingEnabled: true },
        ReputationOptions: { ReputationMetricsEnabled: true },
        // Belt and braces: Amazon also refuses to send to addresses that bounced or complained.
        SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
      })
    );
  }

  const n = sns();
  const { TopicArn } = await n.send(new CreateTopicCommand({ Name: TOPIC }));
  if (!TopicArn) throw new Error("Amazon didn’t return a topic.");
  const account = TopicArn.split(":")[4];
  await n.send(
    new SetTopicAttributesCommand({
      TopicArn,
      AttributeName: "Policy",
      AttributeValue: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowSesToPublish",
            Effect: "Allow",
            Principal: { Service: "ses.amazonaws.com" },
            Action: "sns:Publish",
            Resource: TopicArn,
            Condition: {
              StringEquals: { "AWS:SourceAccount": account },
              ArnLike: { "AWS:SourceArn": `arn:aws:ses:${region()}:${account}:configuration-set/${CONFIG_SET}` },
            },
          },
        ],
      }),
    })
  );

  const dest = {
    Enabled: true,
    MatchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"] as any,
    SnsDestination: { TopicArn },
  };
  try {
    await ses.send(new CreateConfigurationSetEventDestinationCommand({ ConfigurationSetName: CONFIG_SET, EventDestinationName: DEST, EventDestination: dest }));
  } catch (e: any) {
    if (e?.name !== "AlreadyExistsException") throw e;
    await ses.send(new UpdateConfigurationSetEventDestinationCommand({ ConfigurationSetName: CONFIG_SET, EventDestinationName: DEST, EventDestination: dest }));
  }

  await setSetting("sns_topic_arn", TopicArn);
  await setSetting("ses_config_set", CONFIG_SET);
  const url = webhookUrl();
  const subs = await n.send(new ListSubscriptionsByTopicCommand({ TopicArn }));
  const mine = (subs.Subscriptions || []).find(s => s.Endpoint === url);
  if (!mine || mine.SubscriptionArn === "PendingConfirmation") {
    await n.send(new SubscribeCommand({ TopicArn, Protocol: url.startsWith("https:") ? "https" : "http", Endpoint: url, ReturnSubscriptionArn: true }));
  }
  return feedStatus();
}

export async function feedStatus() {
  const [topic, confirmedAt, lastEventAt] = await Promise.all([
    getSetting("sns_topic_arn", ""),
    getSetting("feed_confirmed_at", ""),
    getSetting("feed_last_event_at", ""),
  ]);
  const state = !topic ? "off" : confirmedAt ? "on" : "pending";
  return { state, topic: String(topic || ""), confirmedAt: confirmedAt || null, lastEventAt: lastEventAt || null, configSet: topic ? CONFIG_SET : null };
}

export async function markFeed(kind: "confirmed" | "event") {
  await setSetting(kind === "confirmed" ? "feed_confirmed_at" : "feed_last_event_at", new Date().toISOString());
}
