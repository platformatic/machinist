'use strict'

/**
 * @typedef {Object} MachineController
 * @property {string} name
 */

/**
 * @typedef {Object} MachineResources
 * @property {{ cpu: string, memory: string }} [limits]
 * @property {{ cpu: string, memory: string }} [requests]
 */

/**
 * @typedef {Object} Machine
 * @property {string} id
 * @property {string} status
 * @property {string} startTime        - ISO-8601
 * @property {string} image            - First container image
 * @property {Record<string, string>} labels
 * @property {MachineController} [controller]
 * @property {MachineResources} [resources]
 */

/**
 * @typedef {Object} Controller
 * @property {string} name
 * @property {number} replicas
 * @property {Record<string, string>} labels
 * @property {Machine[]} [machines]
 */

/**
 * @typedef {Object} ServicePort
 * @property {number} port
 * @property {string} [protocol]
 */

/**
 * @typedef {Object} ServiceEndpoint
 * @property {string} name
 * @property {Record<string, string>} labels
 * @property {ServicePort[]} ports
 */

/**
 * Provider interface — every provider must implement these methods.
 *
 * `scope` is a provider-specific resource boundary:
 *   - K8s:  namespace
 *   - ECS:  cluster name
 *
 * @typedef {Object} Provider
 *
 * Machine operations
 * @property {(scope: string, machineId: string) => Promise<Machine>} getMachine
 * @property {(scope: string, labels?: Record<string, string>) => Promise<Machine[]>} getMachines
 * @property {(scope: string, machineId: string, labels: Record<string, string>) => Promise<void>} setMachineLabels
 *
 * Controller operations
 * @property {(scope: string, machineId?: string) => Promise<Controller[]>} getControllers
 * @property {(scope: string, name: string) => Promise<Controller>} getController
 * @property {(scope: string, name: string, replicas: number) => Promise<Controller>} updateControllerReplicas
 * @property {(scope: string, name: string) => Promise<void>} deleteController
 *
 * Service operations
 * @property {(scope: string, labels: Record<string, string>) => Promise<ServiceEndpoint[]>} getServicesByLabels
 * @property {(scope: string, name: string) => Promise<void>} deleteService
 *
 * Skew protection — K8s implements, ECS throws 501
 * @property {(scope: string) => Promise<object[]>} listGateways
 * @property {(scope: string, httpRoute: object) => Promise<object>} applyHTTPRoute
 * @property {(scope: string, name: string) => Promise<void>} deleteHTTPRoute
 *
 * Lifecycle
 * @property {() => Promise<void>} init
 */

module.exports = {}
