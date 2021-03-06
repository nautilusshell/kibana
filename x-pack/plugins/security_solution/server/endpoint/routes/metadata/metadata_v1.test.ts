/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import {
  ILegacyClusterClient,
  IRouter,
  ILegacyScopedClusterClient,
  KibanaResponseFactory,
  RequestHandler,
  RouteConfig,
  SavedObjectsClientContract,
} from 'kibana/server';
import { SavedObjectsErrorHelpers } from '../../../../../../../src/core/server/';
import {
  elasticsearchServiceMock,
  httpServerMock,
  httpServiceMock,
  loggingSystemMock,
  savedObjectsClientMock,
} from '../../../../../../../src/core/server/mocks';
import {
  HostInfo,
  HostResultList,
  HostStatus,
  MetadataQueryStrategyVersions,
} from '../../../../common/endpoint/types';
import { registerEndpointRoutes, METADATA_REQUEST_V1_ROUTE } from './index';
import {
  createMockEndpointAppContextServiceStartContract,
  createMockPackageService,
  createRouteHandlerContext,
} from '../../mocks';
import { EndpointAppContextService } from '../../endpoint_app_context_services';
import { createMockConfig } from '../../../lib/detection_engine/routes/__mocks__';
import { EndpointDocGenerator } from '../../../../common/endpoint/generate_data';
import { Agent, EsAssetReference } from '../../../../../ingest_manager/common/types/models';
import { createV1SearchResponse } from './support/test_support';
import { PackageService } from '../../../../../ingest_manager/server/services';

describe('test endpoint route v1', () => {
  let routerMock: jest.Mocked<IRouter>;
  let mockResponse: jest.Mocked<KibanaResponseFactory>;
  let mockClusterClient: jest.Mocked<ILegacyClusterClient>;
  let mockScopedClient: jest.Mocked<ILegacyScopedClusterClient>;
  let mockSavedObjectClient: jest.Mocked<SavedObjectsClientContract>;
  let mockPackageService: jest.Mocked<PackageService>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routeHandler: RequestHandler<any, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routeConfig: RouteConfig<any, any, any, any>;
  // tests assume that ingestManager is enabled, and thus agentService is available
  let mockAgentService: Required<
    ReturnType<typeof createMockEndpointAppContextServiceStartContract>
  >['agentService'];
  let endpointAppContextService: EndpointAppContextService;
  const noUnenrolledAgent = {
    agents: [],
    total: 0,
    page: 1,
    perPage: 1,
  };

  beforeEach(() => {
    mockClusterClient = elasticsearchServiceMock.createLegacyClusterClient() as jest.Mocked<
      ILegacyClusterClient
    >;
    mockScopedClient = elasticsearchServiceMock.createLegacyScopedClusterClient();
    mockSavedObjectClient = savedObjectsClientMock.create();
    mockClusterClient.asScoped.mockReturnValue(mockScopedClient);
    routerMock = httpServiceMock.createRouter();
    mockResponse = httpServerMock.createResponseFactory();
    endpointAppContextService = new EndpointAppContextService();
    mockPackageService = createMockPackageService();
    mockPackageService.getInstalledEsAssetReferences.mockReturnValue(
      Promise.resolve(([] as unknown) as EsAssetReference[])
    );
    const startContract = createMockEndpointAppContextServiceStartContract();
    endpointAppContextService.start({ ...startContract, packageService: mockPackageService });
    mockAgentService = startContract.agentService!;

    registerEndpointRoutes(routerMock, {
      logFactory: loggingSystemMock.create(),
      service: endpointAppContextService,
      config: () => Promise.resolve(createMockConfig()),
    });
  });

  afterEach(() => endpointAppContextService.stop());

  it('test find the latest of all endpoints', async () => {
    const mockRequest = httpServerMock.createKibanaRequest({});
    const response = createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata());
    mockScopedClient.callAsCurrentUser.mockImplementationOnce(() => Promise.resolve(response));
    [routeConfig, routeHandler] = routerMock.post.mock.calls.find(([{ path }]) =>
      path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
    )!;
    mockAgentService.getAgentStatusById = jest.fn().mockReturnValue('error');
    mockAgentService.listAgents = jest.fn().mockReturnValue(noUnenrolledAgent);
    await routeHandler(
      createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
      mockRequest,
      mockResponse
    );

    expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
    expect(routeConfig.options).toEqual({ authRequired: true, tags: ['access:securitySolution'] });
    expect(mockResponse.ok).toBeCalled();
    const endpointResultList = mockResponse.ok.mock.calls[0][0]?.body as HostResultList;
    expect(endpointResultList.hosts.length).toEqual(1);
    expect(endpointResultList.total).toEqual(1);
    expect(endpointResultList.request_page_index).toEqual(0);
    expect(endpointResultList.request_page_size).toEqual(10);
    expect(endpointResultList.query_strategy_version).toEqual(
      MetadataQueryStrategyVersions.VERSION_1
    );
  });

  it('test find the latest of all endpoints with paging properties', async () => {
    const mockRequest = httpServerMock.createKibanaRequest({
      body: {
        paging_properties: [
          {
            page_size: 10,
          },
          {
            page_index: 1,
          },
        ],
      },
    });

    mockAgentService.getAgentStatusById = jest.fn().mockReturnValue('error');
    mockAgentService.listAgents = jest.fn().mockReturnValue(noUnenrolledAgent);
    mockScopedClient.callAsCurrentUser.mockImplementationOnce(() =>
      Promise.resolve(createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata()))
    );
    [routeConfig, routeHandler] = routerMock.post.mock.calls.find(([{ path }]) =>
      path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
    )!;

    await routeHandler(
      createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
      mockRequest,
      mockResponse
    );

    expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
    expect(mockScopedClient.callAsCurrentUser.mock.calls[0][1]?.body?.query).toEqual({
      bool: {
        must_not: {
          terms: {
            'elastic.agent.id': [
              '00000000-0000-0000-0000-000000000000',
              '11111111-1111-1111-1111-111111111111',
            ],
          },
        },
      },
    });
    expect(routeConfig.options).toEqual({ authRequired: true, tags: ['access:securitySolution'] });
    expect(mockResponse.ok).toBeCalled();
    const endpointResultList = mockResponse.ok.mock.calls[0][0]?.body as HostResultList;
    expect(endpointResultList.hosts.length).toEqual(1);
    expect(endpointResultList.total).toEqual(1);
    expect(endpointResultList.request_page_index).toEqual(10);
    expect(endpointResultList.request_page_size).toEqual(10);
    expect(endpointResultList.query_strategy_version).toEqual(
      MetadataQueryStrategyVersions.VERSION_1
    );
  });

  it('test find the latest of all endpoints with paging and filters properties', async () => {
    const mockRequest = httpServerMock.createKibanaRequest({
      body: {
        paging_properties: [
          {
            page_size: 10,
          },
          {
            page_index: 1,
          },
        ],

        filters: { kql: 'not host.ip:10.140.73.246' },
      },
    });

    mockAgentService.getAgentStatusById = jest.fn().mockReturnValue('error');
    mockAgentService.listAgents = jest.fn().mockReturnValue(noUnenrolledAgent);
    mockScopedClient.callAsCurrentUser.mockImplementationOnce(() =>
      Promise.resolve(createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata()))
    );
    [routeConfig, routeHandler] = routerMock.post.mock.calls.find(([{ path }]) =>
      path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
    )!;

    await routeHandler(
      createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
      mockRequest,
      mockResponse
    );

    expect(mockScopedClient.callAsCurrentUser).toBeCalled();
    expect(mockScopedClient.callAsCurrentUser.mock.calls[0][1]?.body?.query).toEqual({
      bool: {
        must: [
          {
            bool: {
              must_not: {
                terms: {
                  'elastic.agent.id': [
                    '00000000-0000-0000-0000-000000000000',
                    '11111111-1111-1111-1111-111111111111',
                  ],
                },
              },
            },
          },
          {
            bool: {
              must_not: {
                bool: {
                  should: [
                    {
                      match: {
                        'host.ip': '10.140.73.246',
                      },
                    },
                  ],
                  minimum_should_match: 1,
                },
              },
            },
          },
        ],
      },
    });
    expect(routeConfig.options).toEqual({ authRequired: true, tags: ['access:securitySolution'] });
    expect(mockResponse.ok).toBeCalled();
    const endpointResultList = mockResponse.ok.mock.calls[0][0]?.body as HostResultList;
    expect(endpointResultList.hosts.length).toEqual(1);
    expect(endpointResultList.total).toEqual(1);
    expect(endpointResultList.request_page_index).toEqual(10);
    expect(endpointResultList.request_page_size).toEqual(10);
    expect(endpointResultList.query_strategy_version).toEqual(
      MetadataQueryStrategyVersions.VERSION_1
    );
  });

  describe('Endpoint Details route', () => {
    it('should return 404 on no results', async () => {
      const mockRequest = httpServerMock.createKibanaRequest({ params: { id: 'BADID' } });

      mockScopedClient.callAsCurrentUser.mockImplementationOnce(() =>
        Promise.resolve(createV1SearchResponse())
      );

      mockAgentService.getAgentStatusById = jest.fn().mockReturnValue('error');
      mockAgentService.getAgent = jest.fn().mockReturnValue(({
        active: true,
      } as unknown) as Agent);

      [routeConfig, routeHandler] = routerMock.get.mock.calls.find(([{ path }]) =>
        path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
      )!;
      await routeHandler(
        createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
        mockRequest,
        mockResponse
      );

      expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
      expect(routeConfig.options).toEqual({
        authRequired: true,
        tags: ['access:securitySolution'],
      });
      expect(mockResponse.notFound).toBeCalled();
      const message = mockResponse.notFound.mock.calls[0][0]?.body;
      expect(message).toEqual('Endpoint Not Found');
    });

    it('should return a single endpoint with status online', async () => {
      const response = createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata());
      const mockRequest = httpServerMock.createKibanaRequest({
        params: { id: response.hits.hits[0]._id },
      });

      mockAgentService.getAgentStatusById = jest.fn().mockReturnValue('online');
      mockAgentService.getAgent = jest.fn().mockReturnValue(({
        active: true,
      } as unknown) as Agent);
      mockScopedClient.callAsCurrentUser.mockImplementationOnce(() => Promise.resolve(response));

      [routeConfig, routeHandler] = routerMock.get.mock.calls.find(([{ path }]) =>
        path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
      )!;

      await routeHandler(
        createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
        mockRequest,
        mockResponse
      );

      expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
      expect(routeConfig.options).toEqual({
        authRequired: true,
        tags: ['access:securitySolution'],
      });
      expect(mockResponse.ok).toBeCalled();
      const result = mockResponse.ok.mock.calls[0][0]?.body as HostInfo;
      expect(result).toHaveProperty('metadata.Endpoint');
      expect(result.host_status).toEqual(HostStatus.ONLINE);
    });

    it('should return a single endpoint with status error when AgentService throw 404', async () => {
      const response = createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata());

      const mockRequest = httpServerMock.createKibanaRequest({
        params: { id: response.hits.hits[0]._id },
      });

      mockAgentService.getAgentStatusById = jest.fn().mockImplementation(() => {
        SavedObjectsErrorHelpers.createGenericNotFoundError();
      });

      mockAgentService.getAgent = jest.fn().mockImplementation(() => {
        SavedObjectsErrorHelpers.createGenericNotFoundError();
      });

      mockScopedClient.callAsCurrentUser.mockImplementationOnce(() => Promise.resolve(response));

      [routeConfig, routeHandler] = routerMock.get.mock.calls.find(([{ path }]) =>
        path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
      )!;

      await routeHandler(
        createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
        mockRequest,
        mockResponse
      );

      expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
      expect(routeConfig.options).toEqual({
        authRequired: true,
        tags: ['access:securitySolution'],
      });
      expect(mockResponse.ok).toBeCalled();
      const result = mockResponse.ok.mock.calls[0][0]?.body as HostInfo;
      expect(result.host_status).toEqual(HostStatus.ERROR);
    });

    it('should return a single endpoint with status error when status is not offline, online or enrolling', async () => {
      const response = createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata());

      const mockRequest = httpServerMock.createKibanaRequest({
        params: { id: response.hits.hits[0]._id },
      });

      mockAgentService.getAgentStatusById = jest.fn().mockReturnValue('warning');
      mockAgentService.getAgent = jest.fn().mockReturnValue(({
        active: true,
      } as unknown) as Agent);
      mockScopedClient.callAsCurrentUser.mockImplementationOnce(() => Promise.resolve(response));

      [routeConfig, routeHandler] = routerMock.get.mock.calls.find(([{ path }]) =>
        path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
      )!;

      await routeHandler(
        createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
        mockRequest,
        mockResponse
      );

      expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
      expect(routeConfig.options).toEqual({
        authRequired: true,
        tags: ['access:securitySolution'],
      });
      expect(mockResponse.ok).toBeCalled();
      const result = mockResponse.ok.mock.calls[0][0]?.body as HostInfo;
      expect(result.host_status).toEqual(HostStatus.ERROR);
    });

    it('should throw error when endpoint agent is not active', async () => {
      const response = createV1SearchResponse(new EndpointDocGenerator().generateHostMetadata());

      const mockRequest = httpServerMock.createKibanaRequest({
        params: { id: response.hits.hits[0]._id },
      });
      mockScopedClient.callAsCurrentUser.mockImplementationOnce(() => Promise.resolve(response));
      mockAgentService.getAgent = jest.fn().mockReturnValue(({
        active: false,
      } as unknown) as Agent);

      [routeConfig, routeHandler] = routerMock.get.mock.calls.find(([{ path }]) =>
        path.startsWith(`${METADATA_REQUEST_V1_ROUTE}`)
      )!;

      await routeHandler(
        createRouteHandlerContext(mockScopedClient, mockSavedObjectClient),
        mockRequest,
        mockResponse
      );

      expect(mockScopedClient.callAsCurrentUser).toHaveBeenCalledTimes(1);
      expect(mockResponse.customError).toBeCalled();
    });
  });
});
