#!/usr/bin/env bash
#
# E9: how does a REAL ALB match the skew-protection pin?
#
# Everything else is emulated. `services/main/tests/e2e/ecs-provider-alb.test.js`
# runs the provider against floci, which has a real ALB data plane, and that
# covers the routing the provider produces -- but floci is a reimplementation
# and is known to diverge from the AWS reference (a condition with several
# key/value pairs requires all of them to match there, where AWS is satisfied by
# one). Matching semantics and quotas can only be settled here.
#
# Needs one existing HTTP/HTTPS listener and permission to create, tag and
# delete rules on it. No target groups and no backends: every rule the probe
# creates answers with `fixed-response`, which isolates the matching question
# from anything about forwarding.
#
# Safe to run against a live listener, by construction:
#
# - every rule is scoped to the host `plt-skew-probe.invalid` (RFC 2606), which
#   no real client sends, so production traffic cannot match one
# - rules are tagged `plt.dev/managed-by=icc-probe`, never `icc`, so they cannot
#   be confused with the rules ICC manages
# - the priorities used are allocated from the free space on the listener
# - cleanup runs on every exit path, including interrupts
#
# It does temporarily consume 3 of the listener's rule quota.
#
#   ./probe-alb-query-routing.sh --listener <arn> --yes
#
# Record the results next to ecs-skew-protection-plan.md, as T7's were.
#
set -euo pipefail

LISTENER=""
CONFIRMED=""
HOST=plt-skew-probe.invalid
PROBE_TAG_KEY=plt.dev/managed-by
PROBE_TAG_VALUE=icc-probe

while [ $# -gt 0 ]; do
  case "$1" in
    --listener) LISTENER=$2; shift 2 ;;
    --yes) CONFIRMED=1; shift ;;
    *) echo "usage: $0 --listener <arn> --yes" >&2; exit 2 ;;
  esac
done

if [ -z "$LISTENER" ] || [ -z "$CONFIRMED" ]; then
  echo "usage: $0 --listener <arn> --yes" >&2
  echo "Creates and deletes 3 rules on a real ALB listener; pass --yes to confirm." >&2
  exit 2
fi

cleanup () {
  # By tag, so a rule left behind by an interrupted earlier run goes too.
  aws elbv2 describe-rules --listener-arn "$LISTENER" \
    --query 'Rules[?IsDefault==`false`].RuleArn' --output text 2>/dev/null \
    | tr '\t' '\n' \
    | xargs -r -n20 aws elbv2 describe-tags \
        --query "TagDescriptions[?Tags[?Key=='$PROBE_TAG_KEY' && Value=='$PROBE_TAG_VALUE']].ResourceArn" \
        --output text --resource-arns 2>/dev/null \
    | tr '\t' '\n' \
    | xargs -r -n1 aws elbv2 delete-rule --rule-arn 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Where to send the requests: the load balancer this listener belongs to.
LB=$(aws elbv2 describe-listeners --listener-arns "$LISTENER" \
  --query 'Listeners[0].LoadBalancerArn' --output text)
PORT=$(aws elbv2 describe-listeners --listener-arns "$LISTENER" \
  --query 'Listeners[0].Port' --output text)
SCHEME=$(aws elbv2 describe-listeners --listener-arns "$LISTENER" \
  --query 'Listeners[0].Protocol' --output text | tr '[:upper:]' '[:lower:]')
DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$LB" \
  --query 'LoadBalancers[0].DNSName' --output text)

case "$SCHEME" in
  http|https) ;;
  *) echo "listener protocol $SCHEME cannot carry a query-string rule" >&2; exit 2 ;;
esac

echo "listener: $LISTENER"
echo "endpoint: $SCHEME://$DNS:$PORT (Host: $HOST)"
echo

cleanup

# The lowest free run of three priorities, allocated the same way ICC does it:
# a fixed base would collide with whatever the listener already carries, and ALB
# rejects a duplicate priority outright.
BASE=$(aws elbv2 describe-rules --listener-arn "$LISTENER" \
  --query 'Rules[?IsDefault==`false`].Priority' --output text \
  | tr '\t' '\n' | { grep -E '^[0-9]+$' || true; } \
  | awk 'BEGIN { need = 3 } {taken[$1]=1} END {
      for (b = 2; b + need - 1 <= 50000; b++) {
        free = 1
        for (i = 0; i < need; i++) if (taken[b + i]) { free = 0; break }
        if (free) { print b; exit }
      }
      exit 1
    }')
[ -n "$BASE" ] || { echo "no free block of 3 listener priorities" >&2; exit 1; }

fixed () {
  printf '[{"Type":"fixed-response","FixedResponseConfig":{"StatusCode":"200","ContentType":"text/plain","MessageBody":"%s"}}]' "$1"
}
host_condition () {
  printf '{"Field":"host-header","HostHeaderConfig":{"Values":["%s"]}}' "$HOST"
}

# The three rules ICC emits for a hostname-routed application in query mode: a
# query pin, a preview-header pin, and the catch-all standing in for the
# listener default (which belongs to the customer and is not touched).
aws elbv2 create-rule --listener-arn "$LISTENER" --priority "$BASE" \
  --conditions "[$(host_condition),{\"Field\":\"query-string\",\"QueryStringConfig\":{\"Values\":[{\"Key\":\"dpl\",\"Value\":\"v1\"}]}}]" \
  --actions "$(fixed v1)" \
  --tags "Key=$PROBE_TAG_KEY,Value=$PROBE_TAG_VALUE" >/dev/null

aws elbv2 create-rule --listener-arn "$LISTENER" --priority "$(( BASE + 1 ))" \
  --conditions "[$(host_condition),{\"Field\":\"http-header\",\"HttpHeaderConfig\":{\"HttpHeaderName\":\"x-deployment-id\",\"Values\":[\"v1\"]}}]" \
  --actions "$(fixed v1-header)" \
  --tags "Key=$PROBE_TAG_KEY,Value=$PROBE_TAG_VALUE" >/dev/null

aws elbv2 create-rule --listener-arn "$LISTENER" --priority "$(( BASE + 2 ))" \
  --conditions "[$(host_condition)]" \
  --actions "$(fixed active)" \
  --tags "Key=$PROBE_TAG_KEY,Value=$PROBE_TAG_VALUE" >/dev/null

# ALB applies rule changes within seconds; give it a moment before asserting.
sleep 5

fetch () {
  curl -sS --max-time 15 -H "Host: $HOST" "$SCHEME://$DNS:$PORT$1" | tr -d '\r\n'
}

fail=0
check () {
  local query=$1 want=$2 why=$3 got
  got=$(fetch "$query" || echo '<request failed>')
  if [ "$got" = "$want" ]; then
    printf 'ok      %-26s -> %-6s %s\n' "$query" "$got" "$why"
  else
    printf 'FAIL    %-26s -> %-6s (wanted %s: %s)\n' "$query" "${got:-<empty>}" "$want" "$why"
    fail=1
  fi
}
record () {
  printf 'record  %-26s -> %s\n' "$1" "$(fetch "$1" || echo '<request failed>')"
}

echo "-- asserted: the semantics ICC relies on"
check "/"                     active "no pin: the active version serves"
check "/?dpl=v1"              v1     "the premise: a pin reaches its own version"
check "/?dpl=v2"              active "a pin with no rule of its own falls through"
check "/?dpl=v1&utm_source=x" v1     "a pin among other parameters still matches"
check "/?utm_source=x&dpl=v1" v1     "...in any position"
check "/?dpl=v1x"             active "the value is matched whole, not as a prefix"
check "/?dpl="                active "an empty value is not a pin"
# The reference says the comparison is case insensitive, which the emulator
# agrees with. If this line fails, F6 in ecs-skew-protection-plan.md is wrong and
# the version-label guidance changes.
check "/?dpl=V1"              v1     "the value is matched case insensitively"

echo
echo "-- recorded: the questions the emulator cannot answer (E9)"
# The reference reads as "found in the query string", which would match either
# value; the emulator keeps the last occurrence only. ICC never emits such a
# URL, but a client can construct one.
record "/?dpl=v1&dpl=v2"
record "/?dpl=v2&dpl=v1"
# "Case insensitive" is not stated to cover the key. Nothing ICC does depends on
# it, since ICC writes the key itself.
record "/?DPL=v1"
# Wildcards: * and ? are documented as wildcards in a condition VALUE. This asks
# the mirror-image question -- whether they are literal in the REQUEST.
record "/?dpl=v*"

echo
echo "Not probed: the quotas (rules per load balancer, conditions per rule,"
echo "target groups per load balancer). Those need the account's own limits and"
echo "would leave hundreds of rules behind; read them from Service Quotas."

exit $fail
