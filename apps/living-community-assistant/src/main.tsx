import {lazy, StrictMode, Suspense} from 'react';
import {createBrowserRouter, RouterProvider} from 'react-router-dom';
import * as ReactDOM from 'react-dom/client';
const App = lazy(() => import('./app/app'));
const PresentationPage = lazy(() => import('./app/presentation-page'));

const router = createBrowserRouter([
  {path: '/presentation', element: <PresentationPage />},
  {path: '*', element: <App />},
]);

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <StrictMode>
    <Suspense fallback={<p role="status">Loading…</p>}>
      <RouterProvider router={router} />
    </Suspense>
  </StrictMode>
);
