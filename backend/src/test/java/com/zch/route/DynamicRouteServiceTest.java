package com.zch.route;
import tools.jackson.databind.json.JsonMapper;
import com.zch.config.RuntimeConfigSyncProperties;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.*;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.test.StepVerifier;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DynamicRouteServiceTest {
    private RouteStore store;private RouteCompiler compiler;private ActiveRoutes active;private DynamicRouteService service;
    private final JsonMapper mapper=JsonMapper.builder().build();private RouteSnapshot initial;
    @BeforeEach void setup(){
        store=mock(RouteStore.class);compiler=mock(RouteCompiler.class);active=new ActiveRoutes();initial=RouteSnapshot.empty();
        service=new DynamicRouteService(store,compiler,active,new RoutePublicationProperties(),new RuntimeConfigSyncProperties(),mapper);
        when(compiler.compile(any())).thenAnswer(call->build(call.getArgument(0)));
        when(store.read(false,false)).thenReturn(stored(initial));
        when(store.publish(any(),any())).thenAnswer(call->stored(call.getArgument(1)));
        active.adopt(initial,List.of());
    }
    @AfterEach void stop(){service.destroy();}
    private RouteStore.Stored stored(RouteSnapshot s){return new RouteStore.Stored(s.json(mapper),s);}
    private List<org.springframework.cloud.gateway.route.Route> build(RouteSnapshot s){return s.routes().stream().map(r->org.springframework.cloud.gateway.route.Route.async(RouteCompiler.definition(r,s.version())).predicate(x->true).build()).toList();}
    private RouteRuleDto route(){var r=new RouteRuleDto();r.setId("demo");r.setPath("/demo/**");r.setUri("http://127.0.0.1:9000");return r;}
    @ParameterizedTest @NullAndEmptySource
    @ValueSource(strings={"/api/one","file:///etc/passwd","lb://service","http://","http://user:pass@host","https://host:99999","https://host?q=x","https://host#fragment"})
    void rejectsBadUriBeforeWritingRedis(String uri){var input=route();input.setUri(uri);StepVerifier.create(service.save(initial.version(),input)).expectError(RouteValidationException.class).verify();verifyNoInteractions(store);}
    @Test void apiRequiresVersionAndReturnsActionableValidation(){
        var client=WebTestClient.bindToController(new DynamicRouteController(service)).controllerAdvice(new RouteErrorHandler()).build();
        client.post().uri("/settings/routes").bodyValue(route()).exchange().expectStatus().isEqualTo(428).expectHeader().valueEquals("Cache-Control","no-store");
        var bad=route();bad.setUri("relative/path");
        client.post().uri("/settings/routes").bodyValue(Map.of("expectedVersion",initial.version(),"route",bad)).exchange().expectStatus().isBadRequest().expectBody().jsonPath("$.field").isEqualTo("uri");verifyNoInteractions(store);
    }
    @Test void successBindsResponseToActualMatchingRoutes(){
        var response=service.save(initial.version(),route()).block();assertEquals("committed",response.get("outcome"));assertEquals("adopted",response.get("adoption"));
        assertEquals(response.get("version"),active.current().snapshot().version());
        assertEquals(response.get("version"),active.getRoutes().blockFirst().getMetadata().get(RouteCompiler.VERSION));
    }
    @Test void routeEvidenceHeadersComeFromMatchedRouteEvenWhenUpstreamReturnsTheSameHeaders(){
        var snapshot=initial.change(route(),null);
        var exchange=org.springframework.mock.web.server.MockServerWebExchange.from(org.springframework.mock.http.server.reactive.MockServerHttpRequest.get("/demo/proof"));
        exchange.getAttributes().put(org.springframework.cloud.gateway.support.ServerWebExchangeUtils.GATEWAY_ROUTE_ATTR,build(snapshot).getFirst());
        var identity=new RuntimeConfigSyncProperties();
        var filter=new RoutePublicationConfiguration().routeVersionResponse(identity);
        filter.filter(exchange,e->{
            e.getResponse().getHeaders().add("X-Zenith-Route-Version","upstream-value");
            e.getResponse().getHeaders().add("X-Zenith-Instance","upstream-instance");
            return e.getResponse().setComplete();
        }).block();
        assertEquals(List.of(snapshot.version()),exchange.getResponse().getHeaders().get("X-Zenith-Route-Version"));
        assertEquals(List.of(identity.getInstanceId()),exchange.getResponse().getHeaders().get("X-Zenith-Instance"));
    }
    @Test void staleVersionNeverBuildsOrWrites(){
        var newer=initial.change(route(),null);when(store.read(false,false)).thenReturn(stored(newer));
        var error=assertThrows(RouteProblem.class,()->service.save(initial.version(),route()).block());assertEquals(409,error.status());assertEquals(newer,error.response().get("current"));verify(store,never()).publish(any(),any());verifyNoInteractions(compiler);
    }
    @Test void buildFailureRetainsThePreviouslyMatchedSnapshot(){
        doThrow(new IllegalArgumentException("missing filter")).when(compiler).compile(any());
        var error=assertThrows(RouteProblem.class,()->service.save(initial.version(),route()).block());assertEquals("not-written",error.response().get("outcome"));assertEquals(initial,active.current().snapshot());verify(store,never()).publish(any(),any());
    }
    @Test void storageCommitAndLocalAdoptionFailureRemainDistinct(){
        ActiveRoutes foreign=new ActiveRoutes();foreign.adopt(RouteSnapshot.empty(),List.of());
        service.destroy();service=new DynamicRouteService(store,compiler,foreign,new RoutePublicationProperties(),new RuntimeConfigSyncProperties(),mapper);
        var response=service.save(initial.version(),route()).block();assertEquals("committed",response.get("outcome"));assertEquals("pending",response.get("adoption"));assertNotNull(response.get("adoptionIssue"));
    }
    @Test void lostStorageReplyDoesNotGuessSuccessOrAdoptCandidate(){
        doThrow(new RouteProblem(503,"ROUTE_WRITE_UNCONFIRMED","unknown","lost reply")).when(store).publish(any(),any());
        var error=assertThrows(RouteProblem.class,()->service.save(initial.version(),route()).block());assertEquals("unknown",error.response().get("outcome"));assertEquals(initial,active.current().snapshot());verify(store,times(1)).publish(any(),any());
    }
    @Test void managementReadAndDiagnosticsDoNotTriggerAdoption(){
        var newer=initial.change(route(),null);when(store.read(false,false)).thenReturn(stored(newer));service.read().block();assertEquals(initial,active.current().snapshot());
        clearInvocations(store);service.adopted();service.diagnostics();verify(store,never()).read(anyBoolean(),anyBoolean());verifyNoInteractions(compiler);
    }
    @Test void oldBuildCompletingAfterNewPublishCannotRollBackRealLocator()throws Exception{
        var old=initial.change(route(),null);when(store.read(false,true)).thenReturn(stored(old));when(store.read(false,false)).thenReturn(stored(old));
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
        when(compiler.compile(old)).thenAnswer(call->{entered.countDown();assertTrue(release.await(3,TimeUnit.SECONDS));return build(old);});
        var worker=Executors.newSingleThreadExecutor();try{
            var waiting=worker.submit(service::check);assertTrue(entered.await(2,TimeUnit.SECONDS));
            var r=route();r.setUri("http://127.0.0.1:9999");var response=service.save(old.version(),r).block();release.countDown();waiting.get(3,TimeUnit.SECONDS);
            assertEquals(response.get("version"),active.current().snapshot().version());assertEquals("http://127.0.0.1:9999",active.getRoutes().blockFirst().getUri().toString());
        }finally{release.countDown();worker.shutdownNow();}
    }
    @Test void oldReadAfterNewPublishIsIgnoredWithoutBuilding()throws Exception{
        var old=initial.change(route(),null);var newer=old.change(route(),null);active.adopt(newer,build(newer));when(store.read(false,true)).thenReturn(stored(old));service.check();
        assertEquals(newer,active.current().snapshot());verifyNoInteractions(compiler);
    }
    @Test void readFailureNeverPublishesEmptyRoutes(){
        var ready=initial.change(route(),null);active.adopt(ready,build(ready));when(store.read(false,true)).thenThrow(new RouteProblem(503,"ROUTE_STORAGE_MISSING","not-applicable","missing"));service.check();
        assertEquals(ready,active.current().snapshot());assertEquals("failed",service.diagnostics().get("lastCheckOutcome"));
    }
    @Test void invalidStoredEntriesRejectTheWholeSnapshot(){
        String raw=initial.change(route(),null).json(mapper).replace("http://127.0.0.1:9000","/relative");assertThrows(RouteValidationException.class,()->RouteSnapshot.parse(raw,mapper));
        for(String value:List.of("false","null","[]","{}"))assertThrows(Exception.class,()->RouteSnapshot.parse(value,mapper));
    }
    @Test void emptyPublicationActuallyRemovesMatchingRoutes(){
        var one=initial.change(route(),null);active.adopt(one,build(one));var empty=one.change(null,"demo");active.adopt(empty,List.of());assertEquals(0,active.getRoutes().count().block());assertEquals(empty.version(),active.current().snapshot().version());
    }
    @Test void versionAndForwardingObjectsAreOneAtomicValue()throws Exception{
        var worker=Executors.newSingleThreadExecutor();try{
            var writing=worker.submit(()->{var s=initial;for(int i=0;i<500;i++){s=s.change(route(),null);active.adopt(s,build(s));}});
            for(int i=0;i<1000;i++){var value=active.current();assertTrue(value.routes().stream().allMatch(r->value.snapshot().version().equals(r.getMetadata().get(RouteCompiler.VERSION))));}
            writing.get(3,TimeUnit.SECONDS);
        }finally{worker.shutdownNow();}
    }
    @Test void candidateIsDetachedFromMutableInput(){var input=route();var snapshot=initial.change(input,null);input.setUri("http://mutated");assertEquals("http://127.0.0.1:9000",snapshot.routes().getFirst().uri());assertThrows(UnsupportedOperationException.class,()->snapshot.routes().clear());}
    @Test void routeBoundsRejectBeforeStorage(){var r=route();r.setUri("http://host/"+"x".repeat(2048));assertThrows(RouteValidationException.class,()->RouteValidator.normalize(r));var many=new ArrayList<RouteSnapshot.Rule>();for(int i=0;i<257;i++){var entry=route();entry.setId("r"+String.format("%03d",i));many.add(RouteSnapshot.Rule.from(entry));}assertThrows(RouteValidationException.class,()->new RouteSnapshot(1,initial.version(),many));}
    @Test void existingBreakerNamesAndRewriteRemainBoundToTheRoute(){var r=route();r.setCircuitBreakerName("checkout: primary / 订单");var def=RouteCompiler.definition(RouteSnapshot.Rule.from(r),initial.version());assertEquals(r.getCircuitBreakerName(),def.getMetadata().get(com.zch.proxy.ProxyResilienceFilter.NAME));assertEquals(List.of("RewritePath"),def.getFilters().stream().map(f->f.getName()).toList());}
    @ParameterizedTest
    @ValueSource(strings = {"demo/**", "/demo/**/later", "//demo/**"})
    void rejectsInvalidPath(String path) {
        var input = route();
        input.setPath(path);
        assertThrows(RouteValidationException.class, () -> RouteValidator.normalize(input));
    }
    @ParameterizedTest
    @ValueSource(strings = {"/${missing}", "/$9", "/$", "/\\", "//host"})
    void rejectsReplacementWithInvalidGroups(String replacement) {
        var input = route();
        input.setRewriteReplacement(replacement);
        assertThrows(RouteValidationException.class, () -> RouteValidator.normalize(input));
    }
    @Test
    void defaultsEscapeLiteralPathAndPreserveValidNamedGroups() {
        var input = route();
        input.setPath("/v1.0/**");
        var valid = RouteValidator.normalize(input);
        var pattern = java.util.regex.Pattern.compile(valid.getRewriteRegex());
        assertFalse(pattern.matcher("/v1x0/test").matches());
        assertEquals("/test", pattern.matcher("/v1.0/test").replaceAll(valid.getRewriteReplacement()));
    }
    @Test
    void rejectsUnimplementedFallback() {
        var input = route();
        input.setFallbackPath("/settings/runtime");
        assertThrows(RouteValidationException.class, () -> RouteValidator.normalize(input));
    }
}
