'use strict'

// Providers without a single declarative route object take the neutral route
// plan and render it themselves. Kubernetes keeps using /gateway/httproutes;
// see ecs-skew-protection-plan.md D3.

module.exports = async function routes (fastify) {
  fastify.put('/gateway/routeplans/:namespace', {
    schema: {
      description: 'Apply a provider-neutral route plan',
      params: {
        type: 'object',
        properties: {
          namespace: { $ref: 'machinist#/definitions/namespace' }
        }
      },
      body: {
        type: 'object'
      }
    }
  }, async (request) => {
    const { namespace } = request.params
    return fastify.provider.applyRoutePlan(namespace, request.body)
  })
}
