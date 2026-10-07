package com.zch.route;
import java.util.LinkedHashMap;
import java.util.Map;
public class RouteProblem extends RuntimeException {
    private final int status; private final Map<String,Object> body=new LinkedHashMap<>();
    public RouteProblem(int status,String code,String outcome,String message){super(message);this.status=status;body.put("code",code);body.put("outcome",outcome);body.put("message",message);}
    public RouteProblem detail(String key,Object value){body.put(key,value);return this;}
    public int status(){return status;}
    public Map<String,Object> response(){return Map.copyOf(body);}
}
