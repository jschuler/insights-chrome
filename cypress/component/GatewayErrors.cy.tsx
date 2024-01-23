import React, { useEffect, useState } from 'react';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router-dom';
import { Provider, useSelector } from 'react-redux';
import { applyMiddleware, combineReducers, createStore } from 'redux';
import logger from 'redux-logger';
import { removeScalprum } from '@scalprum/core';
import type { AuthContextProps } from 'react-oidc-context';
import { ChromeUser } from '@redhat-cloud-services/types';
import { useSetAtom } from 'jotai';

import chromeReducer from '../../src/redux';
import { userLogIn } from '../../src/redux/actions';
import qe from '../../src/utils/iqeEnablement';
import { COMPLIACE_ERROR_CODES } from '../../src/utils/responseInterceptors';
import testUserJson from '../fixtures/testUser.json';
import { BLOCK_CLEAR_GATEWAY_ERROR } from '../../src/utils/common';
import { initializeVisibilityFunctions } from '../../src/utils/VisibilitySingleton';
import { ReduxState } from '../../src/redux/store';
import GatewayErrorComponent from '../../src/components/ErrorComponents/GatewayErrorComponent';
import { activeModuleAtom } from '../../src/state/atoms/activeModuleAtom';

const testUser: ChromeUser = testUserJson as unknown as ChromeUser;

const ErrorCatcher = ({ children }: { children: React.ReactNode }) => {
  const gatewayError = useSelector(({ chrome: { gatewayError } }: ReduxState) => gatewayError);

  if (gatewayError) {
    return <GatewayErrorComponent error={gatewayError} />;
  }

  return <>{children}</>;
};

function createEnv(code: string, childNode: React.ReactNode) {
  const reduxStore = createStore(combineReducers(chromeReducer()), applyMiddleware(logger));
  // initialize user object for feature flags
  reduxStore.dispatch(userLogIn(testUser));
  // initializes request interceptors
  qe.init(reduxStore, { current: { user: { access_token: 'foo' } } as unknown as AuthContextProps });

  const Component = () => {
    const setActiveModule = useSetAtom(activeModuleAtom);
    useEffect(() => {
      setActiveModule(code);
    }, []);
    return (
      <Provider store={reduxStore}>
        <MemoryRouter initialEntries={['/']}>
          <IntlProvider locale="en">
            <ErrorCatcher>{childNode}</ErrorCatcher>
          </IntlProvider>
        </MemoryRouter>
      </Provider>
    );
  };
  return Component;
}

describe('Gateway errors', () => {
  before(() => {
    initializeVisibilityFunctions({
      getUser() {
        return Promise.resolve(testUser);
      },
      getToken: () => Promise.resolve('a.a'),
      getUserPermissions: () => Promise.resolve([]),
    });
  });
  after(() => {
    window.localStorage.removeItem(BLOCK_CLEAR_GATEWAY_ERROR);
  });
  beforeEach(() => {
    window.localStorage.setItem(BLOCK_CLEAR_GATEWAY_ERROR, 'true');
    cy.intercept('GET', '/api/featureflags/*', { toggles: [] });
    cy.intercept('POST', '/api/featureflags/v0/client/*', {});
    cy.intercept('GET', '/api/chrome-service/v1/static/stable/stage/navigation/*-navigation.json?ts=*', {
      navItems: [],
    });
    cy.intercept('GET', '/api/chrome-service/v1/static/stable/stage/services/services.json', []);
    // clear the instance
    removeScalprum();
  });

  it('handles 403 3scale gateway error', () => {
    const code = 'gateway-403';
    const TestComponent = () => {
      useEffect(() => {
        fetch(`/apps/${code}/fed-mods.json`);
      });
      return null;
    };
    const Component = createEnv(code, <TestComponent />);
    // throw 403 gateway error
    cy.intercept('GET', `/apps/${code}/fed-mods.json`, {
      statusCode: 403,
      body: {
        errors: [
          {
            status: 403,
            detail: 'Gateway has thrown an 403 error',
            meta: {
              response_by: 'gateway',
            },
          },
        ],
      },
    }).as('fedMods');
    cy.mount(<Component />);

    cy.wait('@fedMods');

    cy.contains(`You do not have access to ${code}`).should('exist');
    cy.contains('Detail: Gateway has thrown an 403 error.').should('exist');
  });

  COMPLIACE_ERROR_CODES.forEach((code, index) => {
    it(`handles compliance ${code} gateway error`, () => {
      const moduleName = `module${index}`;
      const TestComponent = () => {
        useEffect(() => {
          fetch(`/${code}/bar`);
        }, []);
        return null;
      };
      const Component = createEnv(moduleName, <TestComponent />);

      cy.intercept('GET', `/${code}/bar`, {
        statusCode: 403,
        Headers: {
          'content-type': 'application/json',
        },
        body: {
          errors: [
            {
              status: 403,
              detail: `Gateway has thrown ${code} compliance error`,
              meta: {
                response_by: 'gateway',
              },
            },
          ],
        },
      }).as(`${code}-call`);

      cy.mount(<Component />);
      cy.wait(`@${code}-call`);
      cy.contains(code).should('exist');
      cy.contains(`Gateway has thrown ${code} compliance error`).should('exist');
    });
  });

  COMPLIACE_ERROR_CODES.forEach((code, index) => {
    it(`handles compliance ${code} string error`, () => {
      const moduleName = `module${index}`;
      const TestComponent = () => {
        useEffect(() => {
          fetch(`/${code}/bar`);
        }, []);
        return null;
      };
      const Component = createEnv(moduleName, <TestComponent />);

      cy.intercept('GET', `/${code}/bar`, {
        statusCode: 403,
        Headers: {
          'content-type': 'text/plain',
        },
        body: `Gateway has thrown ${code} compliance error`,
      }).as(`${code}-call`);

      cy.mount(<Component />);

      cy.wait(`@${code}-call`);
      cy.contains(code).should('exist');
      cy.contains(`Gateway has thrown ${code} compliance error`).should('exist');
    });
  });

  it('should render component if a 403 error does not originate from gateway', () => {
    const code = 'not-gateway-403';

    const TestComponent = () => {
      const [err, setErr] = useState(false);

      return (
        <div>
          {err ? <h1>Component error handler</h1> : <h1>Normal render</h1>}
          <button onClick={() => fetch('/foo/bar').then(() => setErr(true))}>Force API call</button>
        </div>
      );
    };

    const Component = createEnv(code, <TestComponent />);

    // throw 403 gateway error
    cy.intercept('GET', `/foo/bar`, {
      statusCode: 403,
      body: {
        errors: [
          {
            status: 403,
            detail: 'Some API error',
          },
        ],
      },
    }).as(code);
    cy.mount(<Component />);
    cy.contains(`Normal render`).should('exist');
    cy.contains(`Component error handler`).should('not.exist');

    cy.contains('Force API call').click();
    cy.wait(`@${code}`);

    cy.contains(`Normal render`).should('not.exist');
    cy.contains(`Component error handler`).should('exist');
  });

  it('does not handle 404 3scale gateway error', () => {
    const code = 'gateway-404';
    const TestComponent = () => {
      const [err, setErr] = useState(false);

      return (
        <div>
          {err ? <h1>Component error handler</h1> : <h1>Normal render</h1>}
          <button onClick={() => fetch('/foo/bar').then(() => setErr(true))}>Force API call</button>
        </div>
      );
    };
    const Component = createEnv(code, <TestComponent />);
    cy.mount(<Component />);
    cy.contains(`Normal render`).should('exist');
    cy.contains(`Component error handler`).should('not.exist');

    cy.contains('Force API call').click();

    cy.contains(`Normal render`).should('not.exist');
    cy.contains(`Component error handler`).should('exist');
  });
});
