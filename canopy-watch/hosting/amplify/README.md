# Deploy public AI reports to Amplify

The site and AI reports are public. Amplify serves the atlas and its assets, and forwards `/api/interpret` to a Node server. The Compute role reads the OpenAI key from AWS Secrets Manager. A DynamoDB counter caps the entire deployment at 120 OpenAI report requests per UTC day by default. Set `TERRAPHASE_DAILY_REPORT_LIMIT` to change that limit. The evidence download stays available when the limit is reached.

## 1. Prepare AWS resources

Run in AWS CloudShell from the Git checkout. Set the Amplify region and the name of the secret you already created. The command reads the secret ARN only. The secret value may be JSON with an `OPENAI_API_KEY` field or the key as a plain string.

```bash
APP_ID=d2n1h6msaetanz
REGION=YOUR_AMPLIFY_REGION
SITE_ORIGIN=https://main.d2n1h6msaetanz.amplifyapp.com
SECRET_NAME=terraphase/openai
STACK=terraphase-amplify-reports

SECRET_ARN=$(aws secretsmanager describe-secret --region "$REGION" \
  --secret-id "$SECRET_NAME" --query ARN --output text)

aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file canopy-watch/hosting/amplify/resources.yml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides AmplifyAppId="$APP_ID" PublicOrigin="$SITE_ORIGIN" SecretArn="$SECRET_ARN"

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
```

The stack creates a report-quota table and separate Compute and CloudWatch Logs roles. With a customer-managed Secrets Manager encryption key, allow the Compute role `kms:Decrypt` on that key as well.

## 2. Configure Amplify and switch the platform

Under **Amplify → Hosting → Environment variables**, add the three `TERRAPHASE_*` outputs to the `main` branch. These are the site origin, secret ARN and quota table name. Keep the raw API key in Secrets Manager. Keep the Amplify build root at the repository root.

In the same CloudShell session, assign the stack's roles and change the hosting platform.

```bash
stack_output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

COMPUTE_ROLE=$(stack_output ComputeRoleArn)
SERVICE_ROLE=$(aws amplify get-app --region "$REGION" --app-id "$APP_ID" \
  --query app.iamServiceRoleArn --output text)
if [ -z "$SERVICE_ROLE" ] || [ "$SERVICE_ROLE" = None ]; then
  SERVICE_ROLE=$(stack_output ServiceRoleArn)
fi

aws amplify update-app --region "$REGION" --app-id "$APP_ID" \
  --platform WEB_COMPUTE --iam-service-role-arn "$SERVICE_ROLE" --query app.platform
aws amplify update-branch --region "$REGION" --app-id "$APP_ID" \
  --branch-name main --compute-role-arn "$COMPUTE_ROLE" --query branch.branchName
```

If you installed a catch-all SPA rewrite to `/index.html` for static hosting, remove that rewrite in **Hosting → Rewrites and redirects** so API requests reach Compute. Keep any specific domain redirects you need.

## 3. Deploy and verify

Merge the deployment branch into `main` after configuring Amplify. The repository's `amplify.yml` installs the server dependencies and publishes `.amplify-hosting`. Once the `main` build succeeds, run:

```bash
curl -i "$SITE_ORIGIN/api/interpret"
```

Expect HTTP `405` and a JSON response asking for POST. Then open any TerraPhase event and click **Generate AI report**. If the site returns HTTP `503` for that button, check the Compute role, secret ARN, and quota table in CloudWatch. HTTP `429` can indicate the daily quota or an upstream OpenAI rate limit. A redirect or HTML response indicates the request was routed as a page.
