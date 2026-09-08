#!/usr/bin/env bash
# Provisions a Cognito User Pool for the #22 agentgateway demo: a pool with
# a custom `role` attribute, a public app client (no secret — this is a demo
# CLI flow, not a server-to-server integration), a test user, and a Pre
# Token Generation (V2_0) Lambda trigger that copies that user's
# custom:role attribute into a plain `role` claim on the ID token — the
# normalized claim config.yaml.template's CEL policy checks
# (`jwt.role == "editor"`), so it never has to know it's Cognito-shaped.
#
# Deliberately run by *you*, not by an agent: this creates real, persistent
# AWS resources (a User Pool, an IAM role, a Lambda function) under
# whatever AWS credentials/profile are active in your current shell. Every
# other credential in this repo is user-supplied via .env — this is the one
# exception, because there's no credential to supply until this pool
# exists. Review it before running.
#
# Idempotent: safe to re-run. Each step checks for the resource by name
# before creating it.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
POOL_NAME="agentgateway-demo"
CLIENT_NAME="agentgateway-demo-client"
LAMBDA_NAME="agentgateway-demo-role-claim"
LAMBDA_ROLE_NAME="agentgateway-demo-role-claim-exec"
TEST_USERNAME="demo-editor"
TEST_PASSWORD="${COGNITO_TEST_PASSWORD:?Set COGNITO_TEST_PASSWORD in your shell first (Cognito's default password policy requires upper+lower+digit+symbol, 8+ chars)}"

echo "== Region: $REGION =="

# --- User Pool -----------------------------------------------------------
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)"

if [ "$POOL_ID" = "None" ] || [ -z "$POOL_ID" ]; then
  echo "Creating user pool '$POOL_NAME'..."
  # Custom attributes (schema) can only be set at creation time, not added
  # later — hence provisioning role-carrying capability here up front,
  # rather than as a follow-up `update-user-pool`.
  POOL_ID="$(aws cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --region "$REGION" \
    --schema Name=role,AttributeDataType=String,Mutable=true \
    --query 'UserPool.Id' --output text)"
  echo "Created pool: $POOL_ID"
else
  echo "Reusing existing pool: $POOL_ID"
fi

# --- App client (public, no secret) --------------------------------------
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --region "$REGION" \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" --output text)"

if [ "$CLIENT_ID" = "None" ] || [ -z "$CLIENT_ID" ]; then
  echo "Creating app client '$CLIENT_NAME'..."
  CLIENT_ID="$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --region "$REGION" \
    --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query 'UserPoolClient.ClientId' --output text)"
  echo "Created client: $CLIENT_ID"
else
  echo "Reusing existing client: $CLIENT_ID"
fi

# --- IAM execution role for the Lambda trigger ----------------------------
if ! aws iam get-role --role-name "$LAMBDA_ROLE_NAME" >/dev/null 2>&1; then
  echo "Creating IAM role '$LAMBDA_ROLE_NAME'..."
  TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam create-role --role-name "$LAMBDA_ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" >/dev/null
  aws iam attach-role-policy --role-name "$LAMBDA_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "Waiting for IAM role propagation..."
  sleep 10
fi
LAMBDA_ROLE_ARN="$(aws iam get-role --role-name "$LAMBDA_ROLE_NAME" --query 'Role.Arn' --output text)"

# --- Lambda: Pre Token Generation trigger (V2_0) --------------------------
# V2_0 (not the older V1_0) is required to modify the ID token's claims via
# claimsAndScopeOverrideDetails — V1_0 only supports a narrower, older shape.
LAMBDA_SRC_DIR="$(mktemp -d)"
cat > "$LAMBDA_SRC_DIR/index.mjs" << 'EOF'
export const handler = async (event) => {
  const role = event.request.userAttributes["custom:role"] || "viewer";
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: { role },
      },
    },
  };
  return event;
};
EOF
( cd "$LAMBDA_SRC_DIR" && zip -q function.zip index.mjs )

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Updating existing Lambda '$LAMBDA_NAME' code..."
  aws lambda update-function-code --function-name "$LAMBDA_NAME" --region "$REGION" \
    --zip-file "fileb://$LAMBDA_SRC_DIR/function.zip" >/dev/null
else
  echo "Creating Lambda '$LAMBDA_NAME'..."
  aws lambda create-function --function-name "$LAMBDA_NAME" --region "$REGION" \
    --runtime nodejs22.x --role "$LAMBDA_ROLE_ARN" \
    --handler index.handler --zip-file "fileb://$LAMBDA_SRC_DIR/function.zip" >/dev/null
fi
rm -rf "$LAMBDA_SRC_DIR"
LAMBDA_ARN="$(aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text)"

# Cognito needs permission to invoke this Lambda. add-permission is not
# idempotent (errors if the statement already exists) — tolerate that.
aws lambda add-permission --function-name "$LAMBDA_NAME" --region "$REGION" \
  --statement-id "CognitoInvoke-$POOL_ID" --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com --source-arn "arn:aws:cognito-idp:$REGION:$(aws sts get-caller-identity --query Account --output text):userpool/$POOL_ID" \
  >/dev/null 2>&1 || true

echo "Wiring Lambda trigger onto the user pool..."
aws cognito-idp update-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
  --lambda-config "PreTokenGenerationConfig={LambdaVersion=V2_0,LambdaArn=$LAMBDA_ARN}" >/dev/null

# --- Test user, role=editor ------------------------------------------------
if ! aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$TEST_USERNAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Creating test user '$TEST_USERNAME' (custom:role=editor)..."
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --region "$REGION" \
    --username "$TEST_USERNAME" --message-action SUPPRESS \
    --user-attributes Name=custom:role,Value=editor Name=email,Value=demo-editor@example.invalid Name=email_verified,Value=true \
    >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --region "$REGION" \
    --username "$TEST_USERNAME" --password "$TEST_PASSWORD" --permanent >/dev/null
else
  echo "Test user '$TEST_USERNAME' already exists."
fi

ISSUER="https://cognito-idp.$REGION.amazonaws.com/$POOL_ID"
JWKS_URI="$ISSUER/.well-known/jwks.json"

cat << EOF

Done. Put these in agentgateway/.env:

  OIDC_ISSUER=$ISSUER
  OIDC_AUDIENCE=$CLIENT_ID
  OIDC_JWKS_URI=$JWKS_URI

To mint a test ID token for the "$TEST_USERNAME" user (role=editor):

  aws cognito-idp admin-initiate-auth --user-pool-id $POOL_ID --client-id $CLIENT_ID \\
    --auth-flow ADMIN_USER_PASSWORD_AUTH \\
    --auth-parameters USERNAME=$TEST_USERNAME,PASSWORD='<the password you set>' \\
    --region $REGION --query 'AuthenticationResult.IdToken' --output text

Note: this demo uses the ID token as the bearer credential (not the access
token) — Cognito access tokens carry a "client_id" claim, not "aud", so
they don't match config.yaml.template's `audiences` check the way ID
tokens do. That's a Cognito quirk, not a limitation of agentgateway or
this repo's config.

Export the result as AGENTGATEWAY_TOKEN before \`docker compose run pi\`.
To create a second, read-only test user, repeat the admin-create-user step
above with a different username and Value=viewer (or any non-"editor"
value) for custom:role.
EOF
