import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  Chip,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PeopleIcon from '@mui/icons-material/People';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import TimelineIcon from '@mui/icons-material/Timeline';
import HealthAndSafetyIcon from '@mui/icons-material/HealthAndSafety';
import ArticleIcon from '@mui/icons-material/Article';

const DRAWER_WIDTH = 220;

const NAV = [
  { label: '总览', path: '/', icon: <DashboardIcon /> },
  { label: 'Agents', path: '/agents', icon: <PeopleIcon /> },
  { label: 'Pipelines', path: '/pipelines', icon: <AccountTreeIcon /> },
  { label: '消息吞吐', path: '/messages', icon: <TimelineIcon /> },
  { label: '健康检查', path: '/health', icon: <HealthAndSafetyIcon /> },
  { label: '审计日志', path: '/audit', icon: <ArticleIcon /> },
];

interface LayoutProps {
  role: string | null;
}

function Layout({ role }: LayoutProps): React.ReactElement {
  const location = useLocation();

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
        <Toolbar>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            ACH Console v2.5.0
          </Typography>
          <Chip
            label={role === 'admin' ? 'admin' : role ?? 'guest'}
            color={role === 'admin' ? 'success' : 'default'}
            size="small"
            variant="outlined"
            sx={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
          />
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}
      >
        <Toolbar />
        <List>
          {NAV.map((item) => (
            <ListItem key={item.path} disablePadding>
              <ListItemButton
                component={NavLink}
                to={item.path}
                selected={location.pathname === item.path || (item.path === '/' && location.pathname === '/')}
              >
                <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}

export default Layout;
