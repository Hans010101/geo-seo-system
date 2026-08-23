import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";

import CommandCenter from "./pages/CommandCenter";

const Home = lazy(() => import("./pages/Home"));
const QuestionDetail = lazy(() => import("./pages/QuestionDetail"));
const CitationAnalysis = lazy(() => import("./pages/CitationAnalysis"));
const WeeklyReports = lazy(() => import("./pages/WeeklyReports"));
const AlertCenter = lazy(() => import("./pages/AlertCenter"));
const ConfigQuestions = lazy(() => import("./pages/ConfigQuestions"));
const ConfigTargetFacts = lazy(() => import("./pages/ConfigTargetFacts"));
const ConfigOurContent = lazy(() => import("./pages/ConfigOurContent"));
const ConfigPlatforms = lazy(() => import("./pages/ConfigPlatforms"));
const ConfigCollection = lazy(() => import("./pages/ConfigCollection"));
const ConfigScheduler = lazy(() => import("./pages/ConfigScheduler"));
const ConfigUsers = lazy(() => import("./pages/ConfigUsers"));
const ConfigNotifications = lazy(() => import("./pages/ConfigNotifications"));
const SentimentMonitor = lazy(() => import("./pages/SentimentMonitor"));
const SentimentPenetration = lazy(() => import("./pages/SentimentPenetration"));
const MonitorReports = lazy(() => import("./pages/MonitorReports"));
const ConfigMonitorKeywords = lazy(() => import("./pages/ConfigMonitorKeywords"));
const OperationsCenter = lazy(() => import("./pages/OperationsCenter"));
const ReportsCenter = lazy(() => import("./pages/ReportsCenter"));

function Router() {
  return (
    <DashboardLayout>
      <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">正在加载…</div>}>
        <Switch>
          <Route path="/" component={CommandCenter} />
          <Route path="/geo" component={Home} />
          <Route path="/operations" component={OperationsCenter} />
          <Route path="/report-center" component={ReportsCenter} />
          <Route path="/questions" component={QuestionDetail} />
          <Route path="/questions/:questionId" component={QuestionDetail} />
          <Route path="/citations" component={CitationAnalysis} />
          <Route path="/reports" component={WeeklyReports} />
          <Route path="/alerts" component={AlertCenter} />
          <Route path="/sentiment-monitor" component={SentimentMonitor} />
          <Route path="/sentiment-monitor/penetration" component={SentimentPenetration} />
          <Route path="/sentiment-monitor/reports" component={MonitorReports} />
          <Route path="/config/questions" component={ConfigQuestions} />
          <Route path="/config/target-facts" component={ConfigTargetFacts} />
          <Route path="/config/our-content" component={ConfigOurContent} />
          <Route path="/config/platforms" component={ConfigPlatforms} />
          <Route path="/config/collection" component={ConfigCollection} />
          <Route path="/config/scheduler" component={ConfigScheduler} />
          <Route path="/config/users" component={ConfigUsers} />
          <Route path="/config/notifications" component={ConfigNotifications} />
          <Route path="/config/monitor-keywords" component={ConfigMonitorKeywords} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
