import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import LoginGuard from './components/LoginGuard';
import Dashboard from './components/Dashboard';
import AgentList from './components/AgentList';
import PipelineStatus from './components/PipelineStatus';
import ThroughputChart from './components/ThroughputChart';
import HealthPanel from './components/HealthPanel';
import AuditStream from './components/AuditStream';
import Layout from './components/Layout';

const theme = createTheme({
  palette: {
    primary: { main: '#4f46e5' },
    secondary: { main: '#7c3aed' },
    background: { default: '#f9fafb' },
  },
});

function App(): React.ReactElement {
  const [role, setRole] = useState<string | null>(null);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter basename="/dashboard">
        <Routes>
          <Route
            path="/"
            element={
              <LoginGuard role={role} onLogin={setRole}>
                <Layout role={role} />
              </LoginGuard>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<AgentList />} />
            <Route path="pipelines" element={<PipelineStatus />} />
            <Route path="messages" element={<ThroughputChart />} />
            <Route path="health" element={<HealthPanel />} />
            <Route path="audit" element={<AuditStream />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
